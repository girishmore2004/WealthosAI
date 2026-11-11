import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { z } from "zod";
import { PrismaService } from "../../../prisma/prisma.service";
import { scrubPii } from "../../copilot-ingestion/privacy/pii-scrub.util";
import { AGENT_MAX_TOOL_RETRIES, AGENT_TOOL_TIMEOUT_MS } from "../agent.constants";
import { ToolOutcome } from "../agent.types";
import { findForbiddenArgKeys } from "../security/untrusted-content";
import { AgentTool, AgentToolContext, ToolForbiddenError, emptyOutcomeFields, requiresApproval } from "./agent-tool.types";

export interface InvokeOptions {
  callId: string;
  /** Set only by the approval flow after the user said yes to exactly this tool + input. */
  approval?: { approvalId: string };
  /** Makes a retried or duplicated invocation return the first result instead of acting twice. */
  idempotencyKey?: string;
}

export type Gate = { gate: "auto" } | { gate: "approval"; reason: string } | { gate: "denied"; reason: string };

// The only way the agent runs anything. A call is rejected unless the tool is on the allowlist (registered here), its
// arguments carry no identity keys and satisfy a strict schema, the caller is authorised for every resource it names, and
// the risk policy is met. Every invocation — allowed, denied or failed — is recorded in AgentToolExecution with a
// PII-scrubbed copy of the arguments.
@Injectable()
export class ToolRegistryService {
  private readonly logger = new Logger(ToolRegistryService.name);
  private readonly tools = new Map<string, AgentTool>();

  constructor(private prisma: PrismaService) {}

  register(tool: AgentTool): void {
    if (this.tools.has(tool.name)) throw new Error(`Duplicate agent tool: ${tool.name}`);
    this.tools.set(tool.name, tool);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  list(): { name: string; description: string; risk: string; requiresApproval: boolean }[] {
    return [...this.tools.values()].map((t) => ({ name: t.name, description: t.description, risk: t.risk, requiresApproval: requiresApproval(t) }));
  }

  /** Decides, before anything runs, whether a planned call may run now, needs the user's approval, or is not allowed. */
  authorize(name: string, args: Record<string, unknown>): Gate {
    const tool = this.tools.get(name);
    if (!tool) return { gate: "denied", reason: `Tool "${name}" is not available to the agent.` };
    const forbidden = findForbiddenArgKeys(args);
    if (forbidden.length > 0) return { gate: "denied", reason: "Arguments may not set identity or privilege fields." };
    return requiresApproval(tool) ? { gate: "approval", reason: `${tool.risk}-risk action` } : { gate: "auto" };
  }

  /** Validates `args` for `name` without running it (used to show an exact, validated proposal to the user). */
  validate(name: string, args: Record<string, unknown>): { ok: true; input: unknown } | { ok: false; issues: string[] } {
    const tool = this.tools.get(name);
    if (!tool) return { ok: false, issues: [`Unknown tool ${name}`] };
    const parsed = tool.schema.safeParse(args);
    return parsed.success ? { ok: true, input: parsed.data } : { ok: false, issues: formatIssues(parsed.error) };
  }

  async invoke(ctx: AgentToolContext, name: string, rawArgs: Record<string, unknown>, opts: InvokeOptions): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);
    const base = (): ToolOutcome => ({ callId: opts.callId, tool: name, status: "error", text: "", durationMs: Date.now() - started, ...emptyOutcomeFields() });

    if (!tool) return this.deny(ctx, opts, name, "MEDIUM", rawArgs, started, "TOOL_NOT_ALLOWED", `Tool "${name}" is not available to the agent.`, base());

    const forbidden = findForbiddenArgKeys(rawArgs);
    if (forbidden.length > 0) {
      return this.deny(ctx, opts, name, tool.risk, rawArgs, started, "FORBIDDEN_ARGUMENT", "Arguments may not set identity or privilege fields.", base());
    }

    const parsed = tool.schema.safeParse(rawArgs);
    if (!parsed.success) {
      const issues = formatIssues(parsed.error);
      const out = { ...base(), status: "error" as const, text: `I couldn't run ${name}: ${issues.join("; ")}`, handled: false, errorCode: "INVALID_INPUT" };
      await this.record(ctx, opts, tool, rawArgs, "FAILED", started, null, `INVALID_INPUT: ${issues.join("; ")}`);
      return out;
    }
    const input = parsed.data as never;

    if (requiresApproval(tool) && !opts.approval) {
      return this.deny(ctx, opts, name, tool.risk, rawArgs, started, "APPROVAL_REQUIRED", "This action needs your explicit approval first.", base());
    }

    // Idempotency: a repeated request returns what the first one did.
    if (opts.idempotencyKey) {
      const prior = await this.prisma.client.agentToolExecution.findUnique({ where: { userId_idempotencyKey: { userId: ctx.userId, idempotencyKey: opts.idempotencyKey } } });
      if (prior) {
        const summary = (prior.outputSummary ?? {}) as { text?: string };
        return { ...base(), status: prior.status === "SUCCEEDED" ? "ok" : "error", text: summary.text ?? "This action was already carried out.", handled: true, data: { duplicate: true } };
      }
    }

    try {
      if (tool.authorizeResources) await tool.authorizeResources(ctx, input);
    } catch (err) {
      if (err instanceof ToolForbiddenError) {
        return this.deny(ctx, opts, name, tool.risk, rawArgs, started, "NOT_FOUND", "I couldn't find that item in your account.", base());
      }
      throw err;
    }

    let attempt = 0;
    for (;;) {
      try {
        const result = await withTimeout(tool.execute(ctx, input), tool.timeoutMs ?? AGENT_TOOL_TIMEOUT_MS, ctx.signal, name);
        const outcome: ToolOutcome = { ...base(), ...emptyOutcomeFields(), ...result, callId: opts.callId, tool: name, status: "ok", durationMs: Date.now() - started };
        await this.record(ctx, opts, tool, rawArgs, "SUCCEEDED", started, { text: outcome.text.slice(0, 500), handled: outcome.handled }, null, opts.approval?.approvalId);
        return outcome;
      } catch (err) {
        const transient = isTransient(err);
        if (transient && attempt < AGENT_MAX_TOOL_RETRIES) {
          attempt += 1;
          continue;
        }
        const code = (err as Error).name || "Error";
        this.logger.warn(`Tool ${name} failed: ${code}`);
        await this.record(ctx, opts, tool, rawArgs, "FAILED", started, null, code, opts.approval?.approvalId);
        return { ...base(), status: "error", text: `I couldn't complete ${name.replace(/_/g, " ")} right now.`, handled: false, transient, errorCode: code, durationMs: Date.now() - started };
      }
    }
  }

  private async deny(ctx: AgentToolContext, opts: InvokeOptions, name: string, risk: "LOW" | "MEDIUM" | "HIGH", rawArgs: Record<string, unknown>, started: number, code: string, message: string, base: ToolOutcome): Promise<ToolOutcome> {
    await this.prisma.client.agentToolExecution
      .create({
        data: {
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          toolName: name,
          riskLevel: risk,
          inputRedacted: redactArgs(rawArgs),
          status: "DENIED",
          error: code,
          durationMs: Date.now() - started,
        },
      })
      .catch((e: Error) => this.logger.warn(`audit write failed: ${e.name}`));
    return { ...base, status: "denied", text: message, handled: false, errorCode: code, durationMs: Date.now() - started };
  }

  private async record(ctx: AgentToolContext, opts: InvokeOptions, tool: AgentTool, rawArgs: Record<string, unknown>, status: "SUCCEEDED" | "FAILED", started: number, output: Record<string, unknown> | null, error: string | null, approvalId?: string): Promise<void> {
    try {
      await this.prisma.client.agentToolExecution.create({
        data: {
          userId: ctx.userId,
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          toolName: tool.name,
          riskLevel: tool.risk,
          inputRedacted: redactArgs(rawArgs),
          outputSummary: (output ?? undefined) as Prisma.InputJsonValue | undefined,
          status,
          error,
          durationMs: Date.now() - started,
          approvalId: approvalId ?? null,
          // Only a successful run holds the idempotency slot, so a FAILED attempt can be retried by the user.
          idempotencyKey: status === "SUCCEEDED" ? (opts.idempotencyKey ?? null) : null,
        },
      });
    } catch (err) {
      this.logger.warn(`audit write failed: ${(err as Error).name}`);
    }
  }
}

/** PII-scrubbed, size-bounded copy of tool arguments for the audit log. Never contains credentials: tools take none. */
export function redactArgs(args: Record<string, unknown>): Prisma.InputJsonValue {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 4) return "[truncated]";
    if (typeof v === "string") return scrubPii(v).slice(0, 300);
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 30)) out[k] = walk(x, depth + 1);
      return out;
    }
    return v;
  };
  return walk(args, 0) as Prisma.InputJsonValue;
}

function formatIssues(err: z.ZodError): string[] {
  return err.issues.slice(0, 6).map((i) => `${i.path.join(".") || "input"}: ${i.message}`);
}

function isTransient(err: unknown): boolean {
  const e = err as { name?: string; status?: number; code?: string };
  if (e?.name === "AgentToolTimeoutError" || e?.name === "AiUnavailableException") return true;
  if (typeof e?.status === "number" && e.status >= 500) return true;
  return e?.code === "ECONNRESET" || e?.code === "ETIMEDOUT";
}

class AgentToolTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`Tool ${tool} exceeded ${ms}ms`);
    this.name = "AgentToolTimeoutError";
  }
}

function withTimeout<T>(work: Promise<T>, ms: number, signal: AbortSignal | undefined, tool: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AgentToolTimeoutError(tool, ms)), ms);
    const onAbort = () => reject(new AgentToolTimeoutError(tool, ms));
    signal?.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
