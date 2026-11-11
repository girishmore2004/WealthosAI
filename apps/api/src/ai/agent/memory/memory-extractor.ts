import { IntentResult, MemoryCandidate, ToolOutcome } from "../agent.types";

// Deterministic memory extraction from what the USER said and from what the system verifiably did. Nothing here asks a model
// what to remember, and nothing is stored as a verified fact on the strength of an assistant answer:
//   * statements the user made about themselves            → USER_CONFIRMED (their own message is the evidence)
//   * what the platform did (a tool ran, an action ran)    → SYSTEM_VERIFIED episodic record
//   * model-inferred facts                                 → only created later by the consolidation job, as AI_INFERRED

const QUESTION_START = /^\s*(what|why|how|when|where|who|which|can|could|should|would|will|do|does|did|is|are|am|was|were|explain|tell|show|compare|calculate|analy[sz]e|summari[sz]e)\b/i;

export function isQuestion(message: string): boolean {
  return message.trim().endsWith("?") || QUESTION_START.test(message);
}

const CONSTRAINT_TOPICS: { key: string; pattern: RegExp }[] = [
  { key: "emergency_fund", pattern: /emergency fund/i },
  { key: "sip", pattern: /\b(sip|mutual fund)s?\b/i },
  { key: "loan_prepayment", pattern: /\b(prepay|prepayment|foreclos)/i },
  { key: "insurance", pattern: /\b(insurance|polic(?:y|ies))\b/i },
  { key: "retirement", pattern: /\b(retirement|epf|ppf|nps)\b/i },
  { key: "gold", pattern: /\bgold\b/i },
  { key: "property", pattern: /\b(house|home|property|land)\b/i },
];

const PREFERENCE_PATTERNS: { key: string; pattern: RegExp }[] = [
  { key: "preference.risk_tolerance", pattern: /\bmy risk (?:tolerance|appetite|profile) is\s+(.{3,60})/i },
  { key: "preference.repayment_strategy", pattern: /\bi prefer\s+(avalanche|snowball)\b.*/i },
  { key: "preference.communication", pattern: /\b(?:please |always )?(?:keep|give|make) (?:answers|responses|replies|it)\s+(short|brief|concise|detailed)\b.*/i },
  { key: "preference.number_format", pattern: /\b(?:show|use|display)\s+(?:amounts?|numbers?)\s+in\s+(lakhs?|crores?|thousands?|millions?)\b.*/i },
];

const SELF_FACT_PATTERNS: { key: string; pattern: RegExp }[] = [
  { key: "fact.monthly_income", pattern: /\bmy (?:monthly |take[- ]home )?(?:salary|income) is\s+[₹rs.\s]*[\d,]+/i },
  { key: "fact.monthly_rent", pattern: /\bmy (?:monthly )?rent is\s+[₹rs.\s]*[\d,]+/i },
  { key: "fact.dependents", pattern: /\bi have\s+\d+\s+(?:dependents?|kids?|children)\b/i },
  { key: "fact.retirement_age", pattern: /\bi (?:plan|want|hope) to retire (?:at|by)\s+(?:age\s+)?\d{2}\b/i },
];

function clip(text: string, n = 300): string {
  return text.replace(/\s+/g, " ").trim().slice(0, n);
}

export interface ExtractionInput {
  message: string;
  intent: IntentResult;
  outcomes: ToolOutcome[];
  runId: string;
  /** Present when the user approved or rejected a proposed action in this run. */
  approvalDecision?: { decision: "approved" | "rejected"; tool: string; summary: string } | null;
}

export function extractMemoryCandidates(input: ExtractionInput): MemoryCandidate[] {
  const out: MemoryCandidate[] = [];
  const msg = clip(input.message, 400);
  const userEvidence = [{ type: "user_message", ref: input.runId }];

  const asksQuestion = isQuestion(msg);

  // Explicit "remember that ..."
  const explicit = msg.match(/\bremember (?:that )?(.{6,300})$/i);
  if (explicit && !asksQuestion) {
    out.push({ category: "SEMANTIC", subjectKey: null, content: clip(explicit[1]), source: "USER_CONFIRMED", confidence: 1, evidence: userEvidence });
  }

  if (!asksQuestion) {
    // Standing constraints: "don't touch my emergency fund", "never break my SIP".
    const constraint = msg.match(/\b(?:don'?t|do not|never|avoid|must not)\b[^.!?]{0,40}\b(?:touch|use|withdraw|break|stop|cancel|sell|reduce|prepay|redeem)\b[^.!?]{0,60}/i);
    if (constraint) {
      const topic = CONSTRAINT_TOPICS.find((t) => t.pattern.test(constraint[0]))?.key;
      out.push({
        category: "SEMANTIC",
        subjectKey: topic ? `constraint.${topic}` : null,
        content: `Constraint: ${clip(constraint[0])}`,
        source: "USER_CONFIRMED",
        confidence: 1,
        evidence: userEvidence,
      });
    }

    for (const p of PREFERENCE_PATTERNS) {
      const m = msg.match(p.pattern);
      if (m) out.push({ category: "SEMANTIC", subjectKey: p.key, content: `Preference: ${clip(m[0])}`, source: "USER_CONFIRMED", confidence: 1, evidence: userEvidence });
    }
    for (const p of SELF_FACT_PATTERNS) {
      const m = msg.match(p.pattern);
      if (m) out.push({ category: "SEMANTIC", subjectKey: p.key, content: `User stated: ${clip(m[0])}`, source: "USER_CONFIRMED", confidence: 1, evidence: userEvidence });
    }

    // Goals the user states they have.
    const goal = msg.match(/\b(?:my goal is|i want to|i(?:'m| am) (?:planning|trying) to|i(?:'d| would) like to)\s+((?:save|buy|build|reach|retire|pay off|repay|invest|accumulate)[^.!?]{4,160})/i);
    if (goal) {
      out.push({
        category: "GOAL",
        subjectKey: `goal.${slug(goal[1].split(/\s+/).slice(0, 4).join(" "))}`,
        content: `Goal stated by user: ${clip(goal[1])}`,
        source: "USER_CONFIRMED",
        confidence: 1,
        evidence: userEvidence,
      });
    }

    // Recurring instructions the user asked for.
    const procedural = msg.match(/\b(?:always|every (?:month|week|quarter)|each (?:month|week)|from now on)\b[^.!?]{6,160}/i);
    if (procedural) {
      out.push({ category: "PROCEDURAL", subjectKey: null, content: `Standing instruction: ${clip(procedural[0])}`, source: "USER_CONFIRMED", confidence: 1, evidence: userEvidence });
    }

    // A decision the user announced.
    const decision = msg.match(/\b(?:i(?:'ve| have)? decided|we(?:'ve| have)? decided|i(?:'ll| will) go with|let'?s go with)\b[^.!?]{4,200}/i);
    if (decision) {
      out.push({ category: "EPISODIC", subjectKey: null, content: `Decision: ${clip(decision[0])}`, source: "USER_CONFIRMED", confidence: 1, evidence: userEvidence });
    }
  }

  // What the platform verifiably did for the user: an action that was approved/rejected, and which tools answered.
  if (input.approvalDecision) {
    const d = input.approvalDecision;
    out.push({
      category: "EPISODIC",
      subjectKey: null,
      content: `User ${d.decision} proposed action: ${clip(d.summary, 240)}`,
      source: "USER_CONFIRMED",
      confidence: 1,
      evidence: [{ type: "user_approval", ref: input.runId }],
    });
  }

  const answered = input.outcomes.filter((o) => o.status === "ok" && o.handled);
  if (answered.length > 0 && input.intent.intent !== "clarification" && input.intent.intent !== "unsupported_action") {
    out.push({
      category: "EPISODIC",
      subjectKey: null,
      content: `Asked (${input.intent.intent.replace("_", " ")}): ${clip(msg, 200)}. Answered using ${[...new Set(answered.map((o) => o.tool))].join(", ")}.`,
      source: "SYSTEM_VERIFIED",
      confidence: 0.9,
      evidence: [{ type: "execution", ref: input.runId }],
    });
    const rec = answered.flatMap((o) => o.recommendations)[0];
    if (rec) {
      out.push({
        category: "EPISODIC",
        subjectKey: null,
        content: `Recommendation given: ${clip(rec, 240)}`,
        source: "SYSTEM_VERIFIED",
        confidence: 0.8,
        evidence: [{ type: "execution", ref: input.runId }],
      });
    }
  }
  return dedupeCandidates(out);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 40) || "item";
}

function dedupeCandidates(list: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const k = `${c.category}|${c.content.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
