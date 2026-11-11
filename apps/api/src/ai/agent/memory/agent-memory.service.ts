import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { PrismaService } from "../../../prisma/prisma.service";
import { EmbeddingService } from "../../rag/embedding/embedding.service";
import { MemoryCryptoService } from "../security/memory-crypto.service";
import { looksLikeInjection } from "../security/untrusted-content";
import { MemoryCandidate, MemoryCategory, MemorySource, RetrievedMemory } from "../agent.types";
import {
  MEMORY_CANDIDATE_POOL,
  MEMORY_CONTEXT_TTL_DAYS,
  MEMORY_EPISODIC_TTL_DAYS,
  MEMORY_MAX_CONTENT_CHARS,
  MEMORY_MIN_RELEVANCE,
  MEMORY_RETRIEVE_TOP_K,
} from "../agent.constants";
import { assessMemoryWrite, classifyPrivacy, cosine, lexicalOverlap, resolveConflict, scoreMemory } from "./memory-policy";

export type RememberOutcome =
  | { status: "created"; id: string; supersededId?: string }
  | { status: "reinforced"; id: string }
  | { status: "conflict_rejected"; existingId: string }
  | { status: "rejected"; reason: string }
  | { status: "skipped"; reason: string };

export interface MemoryView {
  id: string;
  category: MemoryCategory;
  subjectKey: string | null;
  content: string;
  source: MemorySource;
  verification: string;
  confidence: number;
  privacy: string;
  evidence: unknown;
  expiresAt: string | null;
  reviewAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVE_VERIFICATION = { notIn: ["SUPERSEDED", "REJECTED"] as ("SUPERSEDED" | "REJECTED")[] };

// Long-term memory. PostgreSQL (AgentMemory) is the authoritative store; every query is scoped by userId, and no method
// accepts a memory id without also taking the userId, so one user can never read, correct or delete another user's memory.
@Injectable()
export class AgentMemoryService {
  private readonly logger = new Logger(AgentMemoryService.name);

  constructor(
    private prisma: PrismaService,
    private crypto: MemoryCryptoService,
    private embeddings: EmbeddingService,
  ) {}

  // --- write ------------------------------------------------------------------------------------------------

  async remember(userId: string, candidate: MemoryCandidate, actor: "USER" | "AGENT" | "SYSTEM" = "AGENT"): Promise<RememberOutcome> {
    const content = candidate.content.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CONTENT_CHARS);
    if (content.length < 3) return { status: "rejected", reason: "empty" };
    // Memory must never be a way to smuggle an instruction into a later conversation.
    if (looksLikeInjection(content)) return { status: "rejected", reason: "instruction-like content" };

    const verdict = assessMemoryWrite(candidate);
    if (!verdict.ok) return { status: "rejected", reason: verdict.reason };

    const privacy = classifyPrivacy(content);
    if (privacy === "SENSITIVE" && !this.crypto.isAvailable()) return { status: "skipped", reason: "encryption key not configured" };

    const contentHash = this.crypto.contentHash(userId, content);
    const now = new Date();

    // Same statement already remembered → reinforce, never duplicate.
    const duplicate = await this.prisma.client.agentMemory.findUnique({ where: { userId_contentHash: { userId, contentHash } } });
    if (duplicate) {
      const upgrade = candidate.source === "USER_CONFIRMED" && duplicate.verification !== "USER_CONFIRMED";
      await this.prisma.client.agentMemory.update({
        where: { id: duplicate.id },
        data: {
          accessCount: { increment: 1 },
          // A SUPERSEDED/REJECTED row is revived only by the user restating it.
          ...(upgrade ? { source: "USER_CONFIRMED", verification: "USER_CONFIRMED", confidence: 1, supersededById: null } : {}),
          ...(ttlToDate(candidate.ttlDays, now) ? { expiresAt: ttlToDate(candidate.ttlDays, now) } : {}),
        },
      });
      await this.audit(userId, duplicate.id, "REINFORCED", actor, upgrade ? "confirmed by user" : null);
      return { status: "reinforced", id: duplicate.id };
    }

    // Conflict: same subject, different content.
    let supersededId: string | undefined;
    if (candidate.subjectKey) {
      const existing = await this.prisma.client.agentMemory.findFirst({
        where: { userId, category: candidate.category, subjectKey: candidate.subjectKey, verification: ACTIVE_VERIFICATION },
        orderBy: { updatedAt: "desc" },
      });
      if (existing) {
        const resolution = resolveConflict({ source: existing.source as MemorySource }, { source: candidate.source });
        if (resolution === "reject_candidate") {
          await this.audit(userId, existing.id, "CONFLICT_REJECTED", actor, `lower-trust ${candidate.source} statement did not replace ${existing.source}`);
          return { status: "conflict_rejected", existingId: existing.id };
        }
        supersededId = existing.id;
      }
    }

    const stored = privacy === "SENSITIVE" ? this.crypto.encrypt(content) : content;
    const embedded = await this.embedSafely(content);
    const expiresAt = ttlToDate(candidate.ttlDays === undefined ? defaultTtl(candidate) : candidate.ttlDays, now);

    const created = await this.prisma.client.agentMemory.create({
      data: {
        userId,
        category: candidate.category,
        subjectKey: candidate.subjectKey ?? null,
        content: stored,
        contentHash,
        payload: (candidate.payload ?? undefined) as Prisma.InputJsonValue | undefined,
        source: candidate.source,
        evidence: candidate.evidence as unknown as Prisma.InputJsonValue,
        confidence: verdict.confidence,
        verification: verdict.verification,
        privacy,
        embedding: embedded?.vector ?? [],
        embeddingVersion: embedded?.version ?? null,
        expiresAt,
        reviewAt: candidate.source === "AI_INFERRED" ? new Date(now.getTime() + 30 * DAY_MS) : null,
      },
    });
    if (supersededId) {
      await this.prisma.client.agentMemory.update({ where: { id: supersededId }, data: { verification: "SUPERSEDED", supersededById: created.id } });
      await this.audit(userId, supersededId, "SUPERSEDED", actor, `replaced by ${created.id}`);
    }
    await this.audit(userId, created.id, "CREATED", actor, `${candidate.category}/${candidate.source}`);
    return { status: "created", id: created.id, ...(supersededId ? { supersededId } : {}) };
  }

  // --- read -------------------------------------------------------------------------------------------------

  /** Selective recall for ONE request: relevance-scored, bounded, never the whole history. Standing user constraints
   * ("don't touch my emergency fund") are always included because they govern every answer, not only matching ones. */
  async retrieve(userId: string, query: string, opts: { intent: string; topK?: number } = { intent: "financial_analysis" }): Promise<RetrievedMemory[]> {
    const topK = opts.topK ?? MEMORY_RETRIEVE_TOP_K;
    const now = new Date();
    const rows = await this.prisma.client.agentMemory.findMany({
      where: { userId, verification: ACTIVE_VERIFICATION, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
      orderBy: { updatedAt: "desc" },
      take: MEMORY_CANDIDATE_POOL,
    });
    if (rows.length === 0) return [];

    const q = await this.embedSafely(query);
    const scored: RetrievedMemory[] = [];
    const standing: RetrievedMemory[] = [];
    for (const row of rows) {
      const text = this.crypto.decrypt(row.content);
      if (text === null) continue; // unreadable (rotated key / tampering) → skipped, never guessed
      const semantic = q && row.embeddingVersion === q.version && row.embedding.length === q.vector.length ? cosine(q.vector, row.embedding) : 0;
      const lexical = lexicalOverlap(query, text);
      const { relevance, score } = scoreMemory({
        semantic,
        lexical,
        source: row.source as MemorySource,
        confidence: Number(row.confidence),
        ageDays: (now.getTime() - row.updatedAt.getTime()) / DAY_MS,
        category: row.category as MemoryCategory,
        intent: opts.intent,
      });
      const view: RetrievedMemory = {
        id: row.id,
        category: row.category as MemoryCategory,
        content: text,
        source: row.source as MemorySource,
        verification: row.verification,
        confidence: Number(row.confidence),
        score,
        createdAt: row.createdAt.toISOString(),
        subjectKey: row.subjectKey,
      };
      if (row.verification === "USER_CONFIRMED" && row.subjectKey?.startsWith("constraint.")) standing.push(view);
      else if (relevance >= MEMORY_MIN_RELEVANCE) scored.push(view);
    }
    scored.sort((a, b) => b.score - a.score);
    const picked = [...standing.slice(0, 3), ...scored.filter((m) => !standing.some((s) => s.id === m.id))].slice(0, topK);
    if (picked.length > 0) {
      // Best-effort usage tracking; a failure here must not affect the answer.
      void this.prisma.client.agentMemory
        .updateMany({ where: { userId, id: { in: picked.map((m) => m.id) } }, data: { accessCount: { increment: 1 }, lastAccessedAt: now } })
        .catch(() => undefined);
    }
    return picked;
  }

  async list(userId: string, opts: { category?: MemoryCategory; includeSuperseded?: boolean; take?: number } = {}): Promise<MemoryView[]> {
    const rows = await this.prisma.client.agentMemory.findMany({
      where: {
        userId,
        ...(opts.category ? { category: opts.category } : {}),
        ...(opts.includeSuperseded ? {} : { verification: ACTIVE_VERIFICATION }),
      },
      orderBy: { updatedAt: "desc" },
      take: Math.min(opts.take ?? 100, 200),
    });
    const out: MemoryView[] = [];
    for (const r of rows) {
      const content = this.crypto.decrypt(r.content);
      out.push({
        id: r.id,
        category: r.category as MemoryCategory,
        subjectKey: r.subjectKey,
        content: content ?? "[unreadable: encryption key changed]",
        source: r.source as MemorySource,
        verification: r.verification,
        confidence: Number(r.confidence),
        privacy: r.privacy,
        evidence: r.evidence,
        expiresAt: r.expiresAt?.toISOString() ?? null,
        reviewAt: r.reviewAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      });
    }
    return out;
  }

  // --- user control -------------------------------------------------------------------------------------------

  /** The user corrects a memory: it becomes user-confirmed with the corrected text. Returns false when the memory does
   * not exist OR belongs to someone else (indistinguishable on purpose). */
  async correct(userId: string, memoryId: string, newContent: string): Promise<boolean> {
    const existing = await this.prisma.client.agentMemory.findFirst({ where: { id: memoryId, userId } });
    if (!existing) return false;
    const content = newContent.replace(/\s+/g, " ").trim().slice(0, MEMORY_MAX_CONTENT_CHARS);
    if (content.length < 3 || looksLikeInjection(content)) return false;
    const privacy = classifyPrivacy(content);
    if (privacy === "SENSITIVE" && !this.crypto.isAvailable()) return false;
    const contentHash = this.crypto.contentHash(userId, content);
    const clash = await this.prisma.client.agentMemory.findUnique({ where: { userId_contentHash: { userId, contentHash } } });
    if (clash && clash.id !== memoryId) {
      // The corrected text already exists as another memory: keep that one, drop this one.
      await this.prisma.client.agentMemory.delete({ where: { id: memoryId } });
      await this.prisma.client.agentMemory.update({ where: { id: clash.id }, data: { source: "USER_CONFIRMED", verification: "USER_CONFIRMED", confidence: 1, supersededById: null } });
      await this.audit(userId, memoryId, "CORRECTED", "USER", `merged into ${clash.id}`);
      return true;
    }
    const embedded = await this.embedSafely(content);
    await this.prisma.client.agentMemory.update({
      where: { id: memoryId },
      data: {
        content: privacy === "SENSITIVE" ? this.crypto.encrypt(content) : content,
        contentHash,
        privacy,
        source: "USER_CONFIRMED",
        verification: "USER_CONFIRMED",
        confidence: 1,
        evidence: [{ type: "user_correction", ref: memoryId }] as unknown as Prisma.InputJsonValue,
        embedding: embedded?.vector ?? [],
        embeddingVersion: embedded?.version ?? null,
        reviewAt: null,
        supersededById: null,
      },
    });
    await this.audit(userId, memoryId, "CORRECTED", "USER", null);
    return true;
  }

  async confirm(userId: string, memoryId: string): Promise<boolean> {
    const res = await this.prisma.client.agentMemory.updateMany({
      where: { id: memoryId, userId, verification: { in: ["UNVERIFIED"] } },
      data: { source: "USER_CONFIRMED", verification: "USER_CONFIRMED", confidence: 1, reviewAt: null },
    });
    if (res.count > 0) await this.audit(userId, memoryId, "CONFIRMED", "USER", null);
    return res.count > 0;
  }

  /** Hard delete (the user asked for it to be forgotten). The audit row records THAT it was deleted, never what it said. */
  async remove(userId: string, memoryId: string): Promise<boolean> {
    const res = await this.prisma.client.agentMemory.deleteMany({ where: { id: memoryId, userId } });
    if (res.count > 0) await this.audit(userId, memoryId, "DELETED", "USER", null);
    return res.count > 0;
  }

  async auditTrail(userId: string, take = 100) {
    return this.prisma.client.agentMemoryAudit.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: Math.min(take, 200) });
  }

  // --- retention ----------------------------------------------------------------------------------------------

  /** Deletes memories whose expiry has passed. Returns how many were removed. */
  async purgeExpired(userId?: string): Promise<number> {
    const now = new Date();
    const expired = await this.prisma.client.agentMemory.findMany({
      where: { ...(userId ? { userId } : {}), expiresAt: { lte: now } },
      select: { id: true, userId: true },
      take: 500,
    });
    if (expired.length === 0) return 0;
    await this.prisma.client.agentMemory.deleteMany({ where: { id: { in: expired.map((e) => e.id) } } });
    for (const e of expired) await this.audit(e.userId, e.id, "EXPIRED", "SYSTEM", null);
    return expired.length;
  }

  async audit(userId: string, memoryId: string, action: string, actor: "USER" | "AGENT" | "SYSTEM", detail: string | null): Promise<void> {
    try {
      await this.prisma.client.agentMemoryAudit.create({ data: { userId, memoryId, action, actor, detail } });
    } catch (err) {
      this.logger.warn(`memory audit write failed: ${(err as Error).name}`);
    }
  }

  private async embedSafely(text: string): Promise<{ vector: number[]; version: number } | null> {
    try {
      return await this.embeddings.embedWithVersion(text);
    } catch {
      return null; // lexical recall still works without a vector
    }
  }
}

function ttlToDate(days: number | null | undefined, now: Date): Date | undefined {
  if (days === null || days === undefined) return undefined;
  return new Date(now.getTime() + days * DAY_MS);
}

function defaultTtl(c: MemoryCandidate): number | null {
  if (c.source === "CONVERSATION_CONTEXT") return MEMORY_CONTEXT_TTL_DAYS;
  if (c.category === "EPISODIC") return MEMORY_EPISODIC_TTL_DAYS;
  return null;
}
