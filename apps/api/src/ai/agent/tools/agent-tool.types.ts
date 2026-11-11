import { z } from "zod";
import { ToolOutcome, ToolRisk } from "../agent.types";

/** What a tool run is given. `userId` comes from the authenticated session only — it is not part of any tool's input
 * schema, and a call whose arguments contain one is denied by the registry. */
export interface AgentToolContext {
  userId: string;
  conversationId: string | null;
  runId: string;
  signal?: AbortSignal;
}

/** What a tool returns. The registry fills the bookkeeping fields (callId, durationMs, status). */
export type ToolRunResult = Partial<Omit<ToolOutcome, "callId" | "tool" | "status" | "durationMs">> & { text: string };

export interface AgentTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  risk: ToolRisk;
  /** HIGH always requires approval. For MEDIUM, "never" marks a non-consequential write (e.g. saving a reminder);
   * the default for MEDIUM is "always". LOW never does. */
  approval?: "always" | "never";
  /** Strict schema: unknown keys are rejected, so extra (injected) fields cannot ride along. */
  schema: S;
  timeoutMs?: number;
  /** One line shown to the user when approval is requested. */
  summarize?: (input: z.infer<S>) => string;
  preview?: (input: z.infer<S>) => { label: string; value: string }[];
  /** Resource-level authorization: confirm that every id in `input` belongs to `ctx.userId`. Throws ToolForbiddenError. */
  authorizeResources?: (ctx: AgentToolContext, input: z.infer<S>) => Promise<void>;
  execute: (ctx: AgentToolContext, input: z.infer<S>) => Promise<ToolRunResult>;
}

export class ToolForbiddenError extends Error {
  constructor(message = "Resource not found") {
    super(message);
    this.name = "ToolForbiddenError";
  }
}

export class ToolInputError extends Error {
  constructor(message: string, readonly issues: string[] = []) {
    super(message);
    this.name = "ToolInputError";
  }
}

export function requiresApproval(tool: Pick<AgentTool, "risk" | "approval">): boolean {
  if (tool.risk === "HIGH") return true;
  if (tool.risk === "MEDIUM") return tool.approval !== "never";
  return false;
}

export function emptyOutcomeFields(): Pick<ToolOutcome, "evidence" | "calculations" | "warnings" | "assumptions" | "recommendations" | "followUps" | "proposedActions" | "handled" | "untrusted"> {
  return { evidence: [], calculations: [], warnings: [], assumptions: [], recommendations: [], followUps: [], proposedActions: [], handled: true, untrusted: false };
}
