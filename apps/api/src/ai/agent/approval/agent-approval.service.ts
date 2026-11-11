import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { createHash } from "crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { AGENT_APPROVAL_TTL_MS } from "../agent.constants";
import { ApprovalRequirement, ToolRisk } from "../agent.types";

export interface CreateApprovalInput {
  userId: string;
  conversationId: string;
  threadId: string;
  toolName: string;
  risk: ToolRisk;
  summary: string;
  input: Record<string, unknown>;
}

export interface ApprovalRow {
  id: string;
  userId: string;
  conversationId: string;
  threadId: string;
  toolName: string;
  riskLevel: ToolRisk;
  summary: string;
  proposedInput: unknown;
  status: string;
  idempotencyKey: string;
  result: unknown;
  error: string | null;
  decidedAt: Date | null;
  expiresAt: Date;
  createdAt: Date;
}

/** Stable key for "this tool with these exact arguments": asking twice for the same thing yields the same approval row, and an
 * approved action can only ever run once. Key order in the arguments does not matter. */
export function idempotencyKeyFor(toolName: string, input: Record<string, unknown>): string {
  const canonical = JSON.stringify(sortKeys(input));
  return createHash("sha256").update(toolName).update("\u0000").update(canonical).digest("hex").slice(0, 40);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

// Human approval records. Pure persistence plus state rules; the graph decides WHEN to ask, and the registry decides what a
// tool may do. Every method takes the userId so an approval can only ever be read or decided by the user it belongs to.
@Injectable()
export class AgentApprovalService {
  private readonly logger = new Logger(AgentApprovalService.name);

  constructor(private prisma: PrismaService) {}

  /** Creates (or returns the existing live) approval for this exact tool + input. */
  async createOrReuse(p: CreateApprovalInput): Promise<ApprovalRow> {
    const idempotencyKey = idempotencyKeyFor(p.toolName, p.input);
    const existing = await this.prisma.client.agentApproval.findUnique({ where: { userId_idempotencyKey: { userId: p.userId, idempotencyKey } } });
    if (existing) {
      // A decided or executed approval is final: asking again for the same thing later starts a fresh request only once the
      // old one is not pending (so "create the same goal again next month" is possible), but a pending one is reused.
      if (existing.status === "PENDING" && existing.expiresAt > new Date()) return existing as unknown as ApprovalRow;
      await this.prisma.client.agentApproval.delete({ where: { id: existing.id } });
    }
    const row = await this.prisma.client.agentApproval.create({
      data: {
        userId: p.userId,
        conversationId: p.conversationId,
        threadId: p.threadId,
        toolName: p.toolName,
        riskLevel: p.risk,
        summary: p.summary.slice(0, 300),
        proposedInput: p.input as Prisma.InputJsonValue,
        idempotencyKey,
        expiresAt: new Date(Date.now() + AGENT_APPROVAL_TTL_MS),
      },
    });
    return row as unknown as ApprovalRow;
  }

  async get(userId: string, id: string): Promise<ApprovalRow> {
    const row = await this.prisma.client.agentApproval.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException("Approval not found");
    return row as unknown as ApprovalRow;
  }

  async list(userId: string, status?: string, take = 50): Promise<ApprovalRow[]> {
    const rows = await this.prisma.client.agentApproval.findMany({
      where: { userId, ...(status ? { status: status as never } : {}) },
      orderBy: { createdAt: "desc" },
      take: Math.min(take, 100),
    });
    return rows as unknown as ApprovalRow[];
  }

  /** Atomically moves PENDING → APPROVED/REJECTED. Returns null if it was not pending (already decided, expired, or someone
   * else's), so a double click or replayed request cannot decide twice. */
  async decide(userId: string, id: string, decision: "APPROVED" | "REJECTED"): Promise<ApprovalRow | null> {
    const now = new Date();
    const res = await this.prisma.client.agentApproval.updateMany({
      where: { id, userId, status: "PENDING", expiresAt: { gt: now } },
      data: { status: decision, decidedAt: now },
    });
    if (res.count === 0) {
      await this.prisma.client.agentApproval.updateMany({ where: { id, userId, status: "PENDING", expiresAt: { lte: now } }, data: { status: "EXPIRED" } });
      return null;
    }
    return this.get(userId, id);
  }

  async markExecuted(userId: string, id: string, result: Record<string, unknown>): Promise<void> {
    await this.prisma.client.agentApproval.updateMany({ where: { id, userId }, data: { status: "EXECUTED", executedAt: new Date(), result: result as Prisma.InputJsonValue } });
  }

  async markFailed(userId: string, id: string, error: string): Promise<void> {
    await this.prisma.client.agentApproval.updateMany({ where: { id, userId }, data: { status: "FAILED", error: error.slice(0, 300) } });
  }

  async expireStale(): Promise<number> {
    const res = await this.prisma.client.agentApproval.updateMany({ where: { status: "PENDING", expiresAt: { lte: new Date() } }, data: { status: "EXPIRED" } });
    if (res.count > 0) this.logger.log(`expired ${res.count} stale approvals`);
    return res.count;
  }
}

export function toRequirement(row: Pick<ApprovalRow, "id" | "toolName" | "riskLevel" | "summary" | "expiresAt" | "status">): ApprovalRequirement {
  return { approvalId: row.id, tool: row.toolName, risk: row.riskLevel, summary: row.summary, expiresAt: row.expiresAt.toISOString(), status: row.status as ApprovalRequirement["status"] };
}
