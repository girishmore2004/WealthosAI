import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { RedactionService } from "../../gateway/redaction.service";
import { createHash } from "node:crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { AiSourceType } from "@wealthos/db";
import { ChunkerService } from "../chunking/chunker.service";
import { EmbeddingService, EMBEDDING_MODEL_VERSION } from "../embedding/embedding.service";
import { AiQueueService } from "../../ops/ai-queue.service";
import { ReportsService } from "../../../reports/reports.service";
import { DashboardService } from "../../../dashboard/dashboard.service";
import { MAX_RELATED_SOURCE_EXPANSIONS, SOURCE_PRIORITY } from "../rag.constants";
import { FinancialFactsService } from "../../../common/financial-facts/financial-facts.service";
import { DataHealthService } from "../../../financial-core/data-health/data-health.service";
import { buildFinancialFactSources } from "./financial-fact-sources";

interface SourceDocument {
  sourceType: AiSourceType;
  sourceId: string;
  text: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: Date;
}

interface ChunkRow {
  userId: string;
  sourceType: AiSourceType;
  sourceId: string;
  chunkIndex: number;
  text: string;
  parentText: string;
  metadata: object;
  embedding: number[];
  tokenCount: number;
  sourcePriority: number;
  sourceCreatedAt: Date;
  embeddingModelVersion: number;
  relatedSourceIds: string[];
}

export interface ReindexStats {
  chunksIndexed: number;
  sourceCounts: Record<string, number>;
  sourcesReindexed: number;
  sourcesSkipped: number;
  sourcesRemoved: number;
  embeddingModelMigration: boolean;
}

function sourceKey(s: { sourceType: AiSourceType; sourceId: string }): string {
  return `${s.sourceType}:${s.sourceId}`;
}

function contentHashOf(source: SourceDocument): string {
  // Hashes text AND metadata together — a text-only hash would miss the case where a
  // Document's tags/category (and therefore its relatedSourceIds/citation title) were
  // edited without the underlying OCR text changing, which would otherwise leave a
  // stale graph edge or title cached indefinitely under incremental indexing.
  return createHash("sha256").update(JSON.stringify({ text: source.text, metadata: source.metadata })).digest("hex");
}

@Injectable()
export class RagIndexingService implements OnModuleInit {
  private readonly logger = new Logger(RagIndexingService.name);

  constructor(
    private prisma: PrismaService,
    private chunker: ChunkerService,
    private embedding: EmbeddingService,
    private queue: AiQueueService,
    private reports: ReportsService,
    private dashboard: DashboardService,
    private redaction: RedactionService,
    private facts: FinancialFactsService,
    private dataHealth: DataHealthService,
  ) {}

  onModuleInit() {
    this.queue.registerHandler("rag.reindex.user", async (input) => {
      const { userId } = input as { userId: string };
      return this.reindexUser(userId);
    });
  }

  /** Incremental (delta) reindex: only sources whose content actually changed since
   * the last index get re-chunked and re-embedded — see AiSourceIndexState, which
   * tracks a contentHash per (userId, sourceType, sourceId) precisely so this
   * comparison doesn't require re-reading embeddings themselves. Unchanged sources'
   * existing AiEmbeddingChunk rows are left untouched entirely. Sources removed since
   * the last index (e.g. a deleted Document) have their chunks + state row cleaned up.
   * At this app's per-user data volume (documents, months of reports, coach turns,
   * alerts — realistically low hundreds of source rows at most), *reading* every
   * source on every call is still cheap; what incremental indexing actually saves is
   * the far more expensive re-chunk + re-embed work, which now only happens for what
   * changed — "not a full reindex every time".
   *
   * Embedding-version migration path: if ANY of this user's existing chunks were
   * embedded under a different EMBEDDING_MODEL_VERSION than the one currently active
   * (see embedding.service.ts), every source is treated as dirty for this one call —
   * vectors from two different embedding spaces are not meaningfully comparable via
   * cosine similarity, so a partial re-embed would silently corrupt ranking quality
   * for exactly the chunks that weren't refreshed. The call after that one resumes
   * normal incremental behavior once every chunk shares the current version. */
  async reindexUser(userId: string): Promise<ReindexStats> {
    const sources = await this.gatherSources(userId);
    const relatedMap = computeRelatedSourceIds(sources);

    const [existingStates, staleVersionCount] = await Promise.all([
      this.prisma.client.aiSourceIndexState.findMany({ where: { userId } }),
      this.prisma.client.aiEmbeddingChunk.count({ where: { userId, NOT: { embeddingModelVersion: EMBEDDING_MODEL_VERSION } } }),
    ]);
    const embeddingModelMigration = staleVersionCount > 0;

    const existingByKey = new Map(existingStates.map((s) => [sourceKey(s), s]));
    const currentKeys = new Set(sources.map(sourceKey));

    const dirtySources = sources.filter((s) => {
      if (embeddingModelMigration) return true;
      const existing = existingByKey.get(sourceKey(s));
      return !existing || existing.contentHash !== contentHashOf(s);
    });
    const cleanSourceCount = sources.length - dirtySources.length;
    const removedStates = existingStates.filter((s) => !currentKeys.has(sourceKey(s)));

    this.logger.log(
      `Reindexing user ${userId}: ${dirtySources.length} source(s) dirty, ${cleanSourceCount} unchanged, ${removedStates.length} removed` +
        (embeddingModelMigration ? " (embedding model version changed — full rebuild this pass)" : ""),
    );

    const newRows: ChunkRow[] = [];
    for (const source of dirtySources) {
      const chunks = this.chunker.chunk(source.text);
      if (chunks.length === 0) continue;

      const embeddings = await this.embedding.embedBatch(chunks.map((c) => c.text));
      const relatedSourceIds = relatedMap.get(sourceKey(source)) ?? [];

      chunks.forEach((chunk, i) => {
        newRows.push({
          userId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          chunkIndex: chunk.index,
          text: chunk.text,
          parentText: chunk.parentText,
          metadata: source.metadata,
          embedding: embeddings[i],
          tokenCount: Math.ceil(chunk.text.length / 4),
          sourcePriority: SOURCE_PRIORITY[source.sourceType],
          sourceCreatedAt: source.sourceCreatedAt,
          embeddingModelVersion: EMBEDDING_MODEL_VERSION,
          relatedSourceIds,
        });
      });
    }

    const deleteKeys = [
      ...dirtySources.map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId })),
      ...removedStates.map((s) => ({ sourceType: s.sourceType, sourceId: s.sourceId })),
    ];

    const ops: Promise<unknown>[] = [];
    if (deleteKeys.length > 0) {
      ops.push(this.prisma.client.aiEmbeddingChunk.deleteMany({ where: { userId, OR: deleteKeys } }));
    }
    if (newRows.length > 0) {
      ops.push(this.prisma.client.aiEmbeddingChunk.createMany({ data: newRows }));
    }
    for (const source of dirtySources) {
      const chunkCount = newRows.filter((r) => r.sourceType === source.sourceType && r.sourceId === source.sourceId).length;
      ops.push(
        this.prisma.client.aiSourceIndexState.upsert({
          where: { userId_sourceType_sourceId: { userId, sourceType: source.sourceType, sourceId: source.sourceId } },
          update: { contentHash: contentHashOf(source), chunkCount, indexedAt: new Date() },
          create: {
            userId,
            sourceType: source.sourceType,
            sourceId: source.sourceId,
            contentHash: contentHashOf(source),
            chunkCount,
          },
        }),
      );
    }
    for (const removed of removedStates) {
      ops.push(this.prisma.client.aiSourceIndexState.delete({ where: { id: removed.id } }));
    }

    if (ops.length > 0) {
      // Deletes must precede the createMany they clear space for and precede the
      // state upserts that describe the new state — $transaction runs an array of
      // prepared operations in the order given, all-or-nothing, which is exactly
      // "delete stale rows, insert fresh ones, record what's now indexed" as one
      // atomic step per reindex call.
      await this.prisma.client.$transaction(ops as never[]);
    }

    const sourceCounts: Record<string, number> = {};
    for (const source of sources) {
      sourceCounts[source.sourceType] = (sourceCounts[source.sourceType] ?? 0) + 1;
    }

    return {
      chunksIndexed: newRows.length,
      sourceCounts,
      sourcesReindexed: dirtySources.length,
      sourcesSkipped: cleanSourceCount,
      sourcesRemoved: removedStates.length,
      embeddingModelMigration,
    };
  }

  private async gatherSources(userId: string): Promise<SourceDocument[]> {
    const [documents, coachInteractions, alerts, monthlySnapshot] = await Promise.all([
      this.prisma.client.document.findMany({ where: { userId, ocrText: { not: null } } }),
      this.prisma.client.coachInteraction.findMany({ where: { userId, wasRefused: false }, take: 100, orderBy: { createdAt: "desc" } }),
      this.prisma.client.alert.findMany({ where: { userId }, take: 200, orderBy: { createdAt: "desc" } }),
      this.safeDashboardSummary(userId),
    ]);

    const sources: SourceDocument[] = [];

    for (const doc of documents) {
      // Identifiers (PAN, Aadhaar, account / policy numbers, IFSC, UPI ...) are scrubbed BEFORE
      // the text is chunked, embedded, stored or later handed to a model as context. Without
      // this, OCR of a PAN card or bank statement sat in plaintext in the index.
      const text = this.redaction.redact([doc.summary, doc.ocrText].filter(Boolean).join("\n\n")).text;
      if (!text.trim()) continue;
      sources.push({
        sourceType: "DOCUMENT",
        sourceId: doc.id,
        text,
        // entityType/entityId/documentType let retrieval relate a document to the record it is about.
        metadata: { title: doc.fileName, category: doc.category, tags: doc.tags, entityType: doc.entityType, entityId: doc.entityId, documentType: doc.documentType },
        sourceCreatedAt: doc.createdAt,
      });
    }

    for (const interaction of coachInteractions) {
      sources.push({
        sourceType: "COACH_INTERACTION",
        sourceId: interaction.id,
        text: this.redaction.redact(`Q: ${interaction.question}\nA: ${interaction.answer}`).text,
        metadata: { title: interaction.question, intent: interaction.matchedIntent },
        sourceCreatedAt: interaction.createdAt,
      });
    }

    for (const alert of alerts) {
      sources.push({
        sourceType: "ALERT",
        sourceId: alert.id,
        text: `${alert.title}: ${alert.message}`,
        metadata: { title: alert.title, severity: alert.severity, alertType: alert.type },
        sourceCreatedAt: alert.createdAt,
      });
    }

    // Reports are computed on demand, not stored — index the current month and
    // current financial year's computed report text as of reindex time. Like the
    // snapshot below, this is "current state as of last reindex", not a real
    // historical series; see README limitation.
    try {
      const monthly = await this.reports.monthlyReport(userId);
      sources.push({
        sourceType: "REPORT",
        sourceId: `monthly:${monthly.month}`,
        text: reportToText(monthly),
        metadata: { title: `Monthly report — ${monthly.month}` },
        sourceCreatedAt: new Date(),
      });
    } catch (err) {
      this.logger.warn(`Skipping monthly report indexing for ${userId}: ${(err as Error).message}`);
    }

    // Structured facts about the user's own records (summary, policies, investments, loans,
    // emergency fund, data health). Best-effort like the report/snapshot sources above: a
    // failure here skips these sources rather than failing the whole reindex.
    try {
      for (const fact of await this.gatherFinancialFacts(userId)) {
        sources.push({ ...fact, text: this.redaction.redact(fact.text).text });
      }
    } catch (err) {
      this.logger.warn(`Skipping financial fact indexing for ${userId}: ${(err as Error).name}`);
    }

    if (monthlySnapshot) {
      sources.push({
        sourceType: "SNAPSHOT",
        sourceId: `snapshot:${new Date().toISOString().slice(0, 10)}`,
        text: snapshotToText(monthlySnapshot),
        metadata: { title: "Current financial snapshot" },
        sourceCreatedAt: new Date(),
      });
    }

    return sources;
  }

  // Reads each table once for the whole user (no per-record queries), always scoped by userId.
  private async gatherFinancialFacts(userId: string) {
    const db = this.prisma.client;
    const [position, cashFlow, emergency, policies, investments, cashflows, loans, health] = await Promise.all([
      this.facts.getFinancialPosition(userId),
      this.facts.getMonthlyCashFlow(userId),
      this.facts.getEmergencyCoverage(userId),
      db.insurancePolicy.findMany({ where: { userId }, take: 200 }),
      db.investment.findMany({ where: { userId }, take: 200, include: { valuations: { orderBy: { valuedAt: "desc" }, take: 1 } } }),
      db.investmentCashflow.groupBy({ by: ["investmentId", "type"], where: { userId }, _sum: { amount: true } }),
      db.loan.findMany({ where: { userId }, take: 200 }),
      this.dataHealth.getReport(userId),
    ]);

    const totals = new Map<string, { contributions: number; withdrawals: number }>();
    for (const row of cashflows) {
      const t = totals.get(row.investmentId) ?? { contributions: 0, withdrawals: 0 };
      const amount = Number(row._sum.amount ?? 0);
      if (row.type === "CONTRIBUTION" || row.type === "EMPLOYER_CONTRIBUTION") t.contributions += amount;
      if (row.type === "WITHDRAWAL" || row.type === "SALE") t.withdrawals += amount;
      totals.set(row.investmentId, t);
    }

    return buildFinancialFactSources(
      {
        position,
        cashFlow,
        emergency,
        policies: policies.map((p) => ({
          id: p.id, provider: p.provider, type: p.type, premiumAmount: p.premiumAmount.toString(), premiumFrequency: p.premiumFrequency,
          coverageAmount: p.coverageAmount.toString(), renewalDate: p.renewalDate, nomineeName: p.nomineeName, policyNumber: p.policyNumber,
        })),
        investments: investments.map((i) => ({
          id: i.id, name: i.name, type: i.type,
          currentValue: (i.valuations[0]?.value ?? i.currentValue).toString(), valuedAt: i.valuations[0]?.valuedAt ?? null,
          contributions: (totals.get(i.id)?.contributions ?? 0).toFixed(2), withdrawals: (totals.get(i.id)?.withdrawals ?? 0).toFixed(2),
          sipActive: i.sipActive, monthlyContribution: i.monthlyContribution?.toString() ?? null, contributionFrequency: i.contributionFrequency,
        })),
        loans: loans.map((l) => ({ id: l.id, lender: l.lender, type: l.type, outstandingPrincipal: l.outstandingPrincipal.toString(), emiAmount: l.emiAmount.toString(), interestRateAnnual: l.interestRateAnnual.toString() })),
        dataHealth: health.issues.map((i) => ({ code: i.code, message: i.message, count: i.count, amount: i.amount })),
      },
      new Date(),
    );
  }

  private async safeDashboardSummary(userId: string) {
    try {
      return await this.dashboard.getSummary(userId);
    } catch (err) {
      this.logger.warn(`Skipping snapshot indexing for ${userId}: ${(err as Error).message}`);
      return null;
    }
  }
}

/** Layer 3's edges, computed once at index time (not per-search) — see
 * rag.constants.ts's comment on why this is a small, deterministic, explainable graph
 * over data the app actually has rather than a learned or fabricated relationship:
 *   - DOCUMENT <-> DOCUMENT: linked when they share a category (e.g. two INSURANCE
 *     documents) or at least one tag — the same signal a user would use to group
 *     their own documents by hand.
 *   - REPORT <-> SNAPSHOT: always linked to each other when both exist for a user —
 *     they're two different computed views of the same "current financial state",
 *     so a question answered well by one is very often also well-served by the
 *     other's framing.
 * COACH_INTERACTION and ALERT sources deliberately get no edges here — there's no
 * comparably reliable structural signal (category/tags) for either in the current
 * schema, and inventing one (e.g. fuzzy title matching) would be exactly the kind of
 * dressed-up guess this app's own SOURCE_PRIORITY comment already argues against. */
function computeRelatedSourceIds(sources: SourceDocument[]): Map<string, string[]> {
  const related = new Map<string, string[]>();

  const documents = sources.filter((s) => s.sourceType === "DOCUMENT");
  for (const doc of documents) {
    const docTags = new Set(Array.isArray(doc.metadata.tags) ? (doc.metadata.tags as string[]) : []);
    const docCategory = typeof doc.metadata.category === "string" ? doc.metadata.category : undefined;
    const links: string[] = [];

    for (const other of documents) {
      if (links.length >= MAX_RELATED_SOURCE_EXPANSIONS) break;
      if (other.sourceId === doc.sourceId) continue;
      const otherTags = new Set(Array.isArray(other.metadata.tags) ? (other.metadata.tags as string[]) : []);
      const sameCategory = Boolean(docCategory) && other.metadata.category === docCategory;
      const sharedTag = [...docTags].some((t) => otherTags.has(t));
      if (sameCategory || sharedTag) links.push(other.sourceId);
    }

    related.set(sourceKey(doc), links);
  }

  // A document linked to a record (a policy PDF -> that policy) and the FINANCIAL_FACT source
  // for the same record point at each other, so a question answered by one also pulls in the
  // other. Purely structural: the link is the user's own explicit entityType/entityId.
  const factsByEntity = new Map<string, string>();
  for (const f of sources) {
    if (f.sourceType === "FINANCIAL_FACT" && typeof f.metadata.entityType === "string" && typeof f.metadata.entityId === "string") {
      factsByEntity.set(`${f.metadata.entityType}:${f.metadata.entityId}`, f.sourceId);
    }
  }
  const docsByEntity = new Map<string, string[]>();
  for (const d of documents) {
    if (typeof d.metadata.entityType !== "string" || typeof d.metadata.entityId !== "string") continue;
    const key = `${d.metadata.entityType}:${d.metadata.entityId}`;
    docsByEntity.set(key, [...(docsByEntity.get(key) ?? []), d.sourceId]);
    const factId = factsByEntity.get(key);
    if (factId) related.set(sourceKey(d), [...(related.get(sourceKey(d)) ?? []), factId].slice(0, MAX_RELATED_SOURCE_EXPANSIONS));
  }
  for (const f of sources) {
    if (f.sourceType !== "FINANCIAL_FACT" || typeof f.metadata.entityType !== "string") continue;
    const docs = docsByEntity.get(`${f.metadata.entityType}:${f.metadata.entityId}`);
    if (docs?.length) related.set(sourceKey(f), docs.slice(0, MAX_RELATED_SOURCE_EXPANSIONS));
  }

  const report = sources.find((s) => s.sourceType === "REPORT");
  const snapshot = sources.find((s) => s.sourceType === "SNAPSHOT");
  if (report && snapshot) {
    related.set(sourceKey(report), [...(related.get(sourceKey(report)) ?? []), snapshot.sourceId]);
    related.set(sourceKey(snapshot), [...(related.get(sourceKey(snapshot)) ?? []), report.sourceId]);
  }

  return related;
}

// NOTE: savingsRate on MonthlyReportDTO / DashboardSummaryDTO is ALREADY a percentage
// (e.g. 76.9). It was previously multiplied by 100 again here, indexing "7690.0%".
function reportToText(report: { month: string; income: string; expenses: string; netCashflow: string; savingsRate: number; expensesByCategory: { category: string; amount: string }[] }): string {
  const categoryLines = report.expensesByCategory.map((c) => `${c.category}: ${c.amount}`).join(", ");
  return (
    `Monthly report for ${report.month}. Income: ${report.income}. Expenses: ${report.expenses}. ` +
    `Net cashflow: ${report.netCashflow}. Savings rate: ${report.savingsRate.toFixed(1)}%. ` +
    `Expenses by category: ${categoryLines || "none recorded"}.`
  );
}

function snapshotToText(summary: {
  netWorth: string;
  cashBalance: string;
  monthlyIncome: string;
  monthlyExpenses: string;
  savingsRate: number;
  investmentsValue: string;
  totalDebt: string;
  propertyValue: string;
  emergencyCash?: string;
  totalCash?: string;
  insights: { title: string; detail: string }[];
}): string {
  const insightLines = summary.insights.map((i) => `${i.title}: ${i.detail}`).join("\n");
  return (
    `Current financial snapshot. Net worth: ${summary.netWorth}. Available cash: ${summary.cashBalance}` +
    `${summary.emergencyCash !== undefined ? `, emergency cash: ${summary.emergencyCash}, total cash: ${summary.totalCash ?? summary.cashBalance}` : ""}. ` +
    `Monthly income: ${summary.monthlyIncome}. Monthly expenses: ${summary.monthlyExpenses}. ` +
    `Savings rate: ${summary.savingsRate.toFixed(1)}%. Investments value: ${summary.investmentsValue}. ` +
    `Total debt: ${summary.totalDebt}. Property value: ${summary.propertyValue}.\n${insightLines}`
  );
}
