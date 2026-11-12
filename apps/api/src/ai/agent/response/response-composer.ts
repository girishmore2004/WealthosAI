import { AgentIntent, AgentResponse, AgentAnswerType, ApprovalRequirement, CalculationRef, EvidenceRef, ProposedAction, RetrievedMemory, ToolOutcome } from "../agent.types";

// Builds the user-facing answer from tool outcomes WITHOUT a model: the wording of every figure was written by the
// deterministic service that produced it, and this file only arranges it under honest headings so the reader can tell what
// is a verified fact, what a document says, what is a calculated estimate, what was said in earlier conversations,
// what is assumed and what is merely recommended. It also never adds a number of its own.

const ESTIMATE_TOOLS = new Set(["scenario_simulation", "ml_insights", "financial_calculator"]);
const DOCUMENT_TOOLS = new Set(["rag_search"]);

export interface ComposeInput {
  conversationId: string;
  intent: AgentIntent;
  outcomes: ToolOutcome[];
  memories: RetrievedMemory[];
  proposed: ProposedAction[];
  approvals: ApprovalRequirement[];
  /** Set when the run stopped with a specific message (clarification, refusal, simple answer). */
  override?: { text: string; answerType: AgentAnswerType };
  verification: { passed: boolean; issues: string[] };
  extraWarnings?: string[];
}

export function describeMemory(m: RetrievedMemory): string {
  const when = m.createdAt.slice(0, 10);
  switch (m.source) {
    case "USER_CONFIRMED": return `You told me (${when}): ${m.content}`;
    case "SYSTEM_VERIFIED": return `Recorded from your account (${when}): ${m.content}`;
    case "AI_INFERRED": return `Unconfirmed note I inferred (${when}) — please correct me if this is wrong: ${m.content}`;
    default: return `Earlier in our conversation (${when}): ${m.content}`;
  }
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export function composeResponse(input: ComposeInput): Omit<AgentResponse, "messageId"> {
  const okOutcomes = input.outcomes.filter((o) => o.status === "ok" && o.handled && o.text.trim().length > 0);
  const verifiedFacts: string[] = [];
  const documentEvidence: string[] = [];
  const estimates: string[] = [];
  for (const o of okOutcomes) {
    if (DOCUMENT_TOOLS.has(o.tool)) documentEvidence.push(o.text);
    else if (ESTIMATE_TOOLS.has(o.tool)) estimates.push(o.text);
    else verifiedFacts.push(o.text);
  }
  // Logs of earlier questions ("Asked (planning): …") are not answers; they are only shown when the user asks what we discussed.
  const shownMemories = input.intent === "memory_recall" ? input.memories : input.memories.filter((m) => !(m.category === "EPISODIC" && /^Asked \(/.test(m.content)));
  const memoryLines = shownMemories.map(describeMemory);
  const assumptions = uniq(input.outcomes.flatMap((o) => o.assumptions));
  const recommendations = uniq(input.outcomes.flatMap((o) => o.recommendations));
  const evidence: EvidenceRef[] = [
    ...input.outcomes.flatMap((o) => o.evidence),
    ...shownMemories.map<EvidenceRef>((m) => ({ kind: "memory", label: m.category.toLowerCase(), source: m.source.toLowerCase(), detail: m.content.slice(0, 120), asOf: m.createdAt })),
  ];
  const calculations: CalculationRef[] = input.outcomes.flatMap((o) => o.calculations);
  const warnings = uniq([...input.outcomes.flatMap((o) => o.warnings), ...(input.extraWarnings ?? [])]);
  const followUps = uniq(input.outcomes.flatMap((o) => o.followUps)).slice(0, 4);

  let answerType: AgentAnswerType = "answer";
  let text: string;

  if (input.override) {
    text = input.override.text;
    answerType = input.override.answerType;
  } else if (input.approvals.some((a) => a.status === "PENDING")) {
    answerType = "approval_request";
    text = ["I've prepared this for your approval. Nothing has been changed yet:", ...input.proposed.map((p) => `• ${p.summary}${p.preview?.length ? ` (${p.preview.map((x) => `${x.label}: ${x.value}`).join(", ")})` : ""}`), "", "Approve or reject it and I'll carry it out exactly as shown."].join("\n");
    if (okOutcomes.length > 0) text = `${sectioned({ verifiedFacts, documentEvidence, estimates, memoryLines: [], assumptions: [], recommendations: [] })}\n\n${text}`;
  } else if (input.outcomes.some((o) => ACTION_TOOLS.has(o.tool))) {
    answerType = "action_result";
    text = input.outcomes.filter((o) => ACTION_TOOLS.has(o.tool)).map((o) => o.text).join("\n");
  } else if (okOutcomes.length === 0 && memoryLines.length === 0) {
    const failed = input.outcomes.some((o) => o.status === "error");
    text = failed
      ? "I couldn't complete that right now. Nothing was changed, and no figures were guessed. Please try again in a moment."
      : "I don't have enough information in your account to answer that, and I won't guess. Tell me a bit more, or add the missing data and ask again.";
  } else {
    text = sectioned({ verifiedFacts, documentEvidence, estimates, memoryLines, assumptions, recommendations });
  }

  const execution = executionState(input);
  return {
    conversationId: input.conversationId,
    response: text,
    intent: input.intent,
    answerType,
    sections: { verifiedFacts, documentEvidence, historicalMemory: memoryLines, calculatedEstimates: estimates, assumptions, recommendations },
    evidence: evidence.slice(0, 25),
    calculations: calculations.slice(0, 20),
    actionsProposed: input.proposed,
    approvals: input.approvals,
    execution,
    followUps,
    warnings,
    confidence: confidenceOf(input, okOutcomes),
    verification: input.verification,
  };
}

const ACTION_TOOLS = new Set(["create_goal", "update_goal", "create_plan", "create_task", "process_document"]);

function sectioned(s: { verifiedFacts: string[]; documentEvidence: string[]; estimates: string[]; memoryLines: string[]; assumptions: string[]; recommendations: string[] }): string {
  const blocks: [string, string[]][] = [
    ["From your data", s.verifiedFacts],
    ["From your documents", s.documentEvidence],
    ["Calculated estimates", s.estimates],
    ["From our earlier conversations", s.memoryLines],
    ["Assumptions", s.assumptions.map((a) => `• ${a}`)],
    ["Suggested next steps", s.recommendations.map((r) => `• ${r}`)],
  ];
  const present = blocks.filter(([, lines]) => lines.length > 0);
  // One plain block needs no heading: a simple answer stays simple.
  if (present.length === 1 && present[0][0] !== "From our earlier conversations") return present[0][1].join("\n\n");
  return present.map(([title, lines]) => `${title}:\n${lines.join("\n")}`).join("\n\n");
}

function executionState(input: ComposeInput): AgentResponse["execution"] {
  const toolCalls = input.outcomes.map((o) => ({ tool: o.tool, status: o.status }));
  const actions = input.outcomes.filter((o) => ACTION_TOOLS.has(o.tool));
  if (input.approvals.some((a) => a.status === "PENDING")) return { status: "awaiting_approval", toolCalls };
  if (input.approvals.some((a) => a.status === "REJECTED")) return { status: "rejected", toolCalls };
  if (actions.length === 0) return { status: "none", toolCalls };
  if (actions.every((o) => o.status === "ok")) return { status: "executed", toolCalls };
  if (actions.some((o) => o.status === "ok")) return { status: "partial", toolCalls };
  return { status: "failed", toolCalls };
}

function confidenceOf(input: ComposeInput, ok: ToolOutcome[]): number {
  if (input.override) return input.override.answerType === "refusal" ? 1 : 0.8;
  if (ok.length === 0) return 0.2;
  const failures = input.outcomes.filter((o) => o.status === "error").length;
  const base = input.verification.passed ? 0.9 : 0.5;
  const rag = ok.find((o) => o.tool === "rag_search")?.data as { answerConfidence?: number | null } | undefined;
  const ragAdj = rag?.answerConfidence != null ? Math.min(base, rag.answerConfidence) : base;
  return Math.max(0.1, Number((ragAdj - failures * 0.15).toFixed(2)));
}
