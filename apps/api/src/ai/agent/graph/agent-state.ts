import { Annotation } from "@langchain/langgraph";
import { AgentAnswerType, AgentResponse, ApprovalRequirement, IntentResult, MemoryCandidate, PlannedCall, ProposedAction, RetrievedMemory, ToolOutcome } from "../agent.types";
import { HistoryTurn } from "../intent/agent-intent.service";

const last = <T>(init: () => T) => Annotation<T>({ reducer: (_prev: T, next: T) => next, default: init });

export interface PendingApproval {
  approvalId: string;
  tool: string;
  input: Record<string, unknown>;
  summary: string;
  risk: "LOW" | "MEDIUM" | "HIGH";
  preview?: { label: string; value: string }[];
}

export interface ApprovalDecisionPayload {
  decision: "approved" | "rejected";
}

/** The typed state that flows through the graph and is checkpointed after every step. It carries identifiers and
 * results only — never credentials. `userId` is set once from the authenticated session and no node ever derives it from
 * model output. */
export const AgentState = Annotation.Root({
  // --- identity & input (set once) -------------------------------------------------------------------
  userId: last<string>(() => ""),
  conversationId: last<string>(() => ""),
  runId: last<string>(() => ""),
  message: last<string>(() => ""),
  history: last<HistoryTurn[]>(() => []),
  attachmentIds: last<string[]>(() => []),
  // --- understanding ----------------------------------------------------------------------------------
  question: last<string>(() => ""),
  memories: last<RetrievedMemory[]>(() => []),
  intent: last<IntentResult | null>(() => null),
  // --- planning & execution ----------------------------------------------------------------------------
  plan: last<PlannedCall[]>(() => []),
  autoCalls: last<PlannedCall[]>(() => []),
  approvalCall: last<PlannedCall | null>(() => null),
  /** Tool outcomes by callId: a retried call REPLACES its failed attempt instead of adding a second entry. */
  toolOutcomes: Annotation<ToolOutcome[]>({
    reducer: (prev: ToolOutcome[], next: ToolOutcome[]) => {
      const byId = new Map(prev.map((o) => [o.callId, o]));
      for (const o of next) byId.set(o.callId, o);
      return [...byId.values()];
    },
    default: () => [],
  }),
  attempts: last<number>(() => 0),
  stepCount: last<number>(() => 0),
  // --- approval ----------------------------------------------------------------------------------------
  pendingApproval: last<PendingApproval | null>(() => null),
  approvalDecision: last<"approved" | "rejected" | null>(() => null),
  approvals: last<ApprovalRequirement[]>(() => []),
  proposed: last<ProposedAction[]>(() => []),
  // --- result ------------------------------------------------------------------------------------------
  override: last<{ text: string; answerType: AgentAnswerType } | null>(() => null),
  warnings: Annotation<string[]>({ reducer: (a: string[], b: string[]) => [...new Set([...a, ...b])], default: () => [] }),
  verification: last<{ passed: boolean; issues: string[] }>(() => ({ passed: true, issues: [] })),
  response: last<Omit<AgentResponse, "messageId"> | null>(() => null),
  memoryCandidates: last<MemoryCandidate[]>(() => []),
});

export type AgentGraphState = typeof AgentState.State;
