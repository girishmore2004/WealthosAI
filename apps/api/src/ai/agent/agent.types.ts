import { z } from "zod";
import type { ToolResult } from "../financial-engine/financial-types";

export const AGENT_INTENTS = [
  "simple_question",
  "financial_analysis",
  "document_question",
  "planning",
  "scenario_analysis",
  "action_request",
  "memory_recall",
  "unsupported_action",
  "clarification",
] as const;
export type AgentIntent = (typeof AGENT_INTENTS)[number];

/** Intents a model is allowed to pick between when the rules are unsure (a model never selects
 * `unsupported_action`: that decision is rule-only so it cannot be talked out of). */
export const LLM_CLASSIFIABLE_INTENTS = [
  "simple_question",
  "financial_analysis",
  "document_question",
  "planning",
  "scenario_analysis",
  "action_request",
  "memory_recall",
] as const;

export type AgentAnswerType = "answer" | "approval_request" | "clarification" | "action_result" | "refusal";
export type ToolRisk = "LOW" | "MEDIUM" | "HIGH";
export type EvidenceKind = "platform_data" | "document" | "memory" | "estimate";
export type MemoryCategory = "EPISODIC" | "SEMANTIC" | "GOAL" | "PROCEDURAL";
export type MemorySource = "USER_CONFIRMED" | "SYSTEM_VERIFIED" | "AI_INFERRED" | "CONVERSATION_CONTEXT";

export interface IntentResult {
  intent: AgentIntent;
  confidence: number;
  /** Why this intent was chosen — kept for observability, never shown as a claim about the user's data. */
  reasons: string[];
  /** Tool the user is asking to run, for action_request. */
  actionTool?: "create_goal" | "update_goal" | "create_plan" | "create_task";
  source: "rules" | "model" | "default";
}

export interface PlannedCall {
  callId: string;
  tool: string;
  /** Raw (not yet validated) arguments. The registry validates them against the tool's strict schema. */
  args: Record<string, unknown>;
  /** Run only if the previous call reported it could not answer (e.g. the finance engine handed off). */
  runIf?: "previous_unhandled";
  purpose: string;
}

export interface EvidenceRef {
  kind: EvidenceKind;
  label: string;
  /** Tool or store the evidence came from. */
  source: string;
  detail?: string;
  asOf?: string;
}

export interface CalculationRef {
  label: string;
  value: string;
  method: string;
  /** Always a deterministic service, never the model. */
  source: string;
  basis?: string;
}

export interface ProposedAction {
  approvalId: string | null;
  tool: string;
  risk: ToolRisk;
  summary: string;
  input: Record<string, unknown>;
  preview?: { label: string; value: string }[];
}

export interface ToolOutcome {
  callId: string;
  tool: string;
  status: "ok" | "error" | "denied" | "skipped";
  /** Plain-language result written by code (or by an existing verified pipeline). */
  text: string;
  /** False when the tool could not answer and a fallback may run. */
  handled: boolean;
  evidence: EvidenceRef[];
  calculations: CalculationRef[];
  /** Deterministic facts, kept so the agent can numerically verify what it says. */
  facts?: ToolResult[];
  /** True when `text` contains passages from user documents. It is data, never instructions. */
  untrusted: boolean;
  warnings: string[];
  assumptions: string[];
  recommendations: string[];
  followUps: string[];
  proposedActions: { tool: string; input: Record<string, unknown>; summary: string; preview?: { label: string; value: string }[] }[];
  /** Whether the failure may succeed on retry (timeouts, upstream 5xx). Validation / authorization errors never are. */
  transient?: boolean;
  errorCode?: string;
  durationMs: number;
  /** Bounded structured payload returned to the client (never raw database rows). */
  data?: Record<string, unknown>;
}

export interface ApprovalRequirement {
  approvalId: string;
  tool: string;
  risk: ToolRisk;
  summary: string;
  expiresAt: string;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "EXECUTED" | "FAILED";
}

export interface RetrievedMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  source: MemorySource;
  verification: string;
  confidence: number;
  score: number;
  createdAt: string;
  subjectKey: string | null;
}

export interface MemoryCandidate {
  category: MemoryCategory;
  subjectKey?: string | null;
  content: string;
  source: MemorySource;
  confidence: number;
  evidence: { type: string; ref: string }[];
  ttlDays?: number | null;
  payload?: Record<string, unknown> | null;
}

export interface AgentResponse {
  conversationId: string;
  messageId: string | null;
  response: string;
  intent: AgentIntent;
  answerType: AgentAnswerType;
  sections: {
    verifiedFacts: string[];
    documentEvidence: string[];
    historicalMemory: string[];
    calculatedEstimates: string[];
    assumptions: string[];
    recommendations: string[];
  };
  evidence: EvidenceRef[];
  calculations: CalculationRef[];
  actionsProposed: ProposedAction[];
  approvals: ApprovalRequirement[];
  execution: { status: "none" | "awaiting_approval" | "executed" | "rejected" | "failed" | "partial"; toolCalls: { tool: string; status: string }[] };
  followUps: string[];
  warnings: string[];
  confidence: number;
  verification: { passed: boolean; issues: string[] };
}

// --- request validation (also used by the controller's DTO) ----------------------------------------------
export const attachmentRefSchema = z.object({ documentId: z.string().min(1).max(64) }).strict();
export const interactionContextSchema = z
  .object({
    page: z.string().max(60).optional(),
    goalId: z.string().max(64).optional(),
    planId: z.string().max(64).optional(),
  })
  .strict();
