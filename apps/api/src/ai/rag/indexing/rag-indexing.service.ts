import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { AiSourceType } from "@wealthos/db";
import { ChunkerService } from "../chunking/chunker.service";
import { EmbeddingService } from "../embedding/embedding.service";
import { AiQueueService } from "../../ops/ai-queue.service";
import { ReportsService } from "../../../reports/reports.service";
import { DashboardService } from "../../../dashboard/dashboard.service";
import { SOURCE_PRIORITY } from "../rag.constants";

interface SourceDocument {
  sourceType: AiSourceType;
  sourceId: string;
  text: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: Date;
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
  ) {}

  onModuleInit() {
    this.queue.registerHandler("rag.reindex.user", async (input) => {
      const { userId } = input as { userId: string };
      return this.reindexUser(userId);
    });
  }

  /** Full re-index: deletes and rebuilds every AiEmbeddingChunk for this user. Simple
   * and correct over incremental — at this app's per-user data volume (documents,
   * months of reports, coach turns, alerts — realistically low hundreds of source
   * rows at most), a full rebuild costs a few seconds of embedding calls, and
   * "delete + rebuild" can never drift out of sync with the source tables the way an
   * incremental upsert-or-miss-a-case approach eventually would. Revisit if/when a
   * user's data volume actually makes that cost noticeable. */
  async reindexUser(userId: string): Promise<{ chunksIndexed: number; sourceCounts: Record<string, number> }> {
    const sources = await this.gatherSources(userId);
    this.logger.log(`Reindexing ${sources.length} source documents for user ${userId}`);

    const rows: {
      userId: string;
      sourceType: AiSourceType;
      sourceId: string;
      chunkIndex: number;
      text: string;
      metadata: object;
      embedding: number[];
      tokenCount: number;
      sourcePriority: number;
      sourceCreatedAt: Date;
    }[] = [];

    for (const source of sources) {
      const chunks = this.chunker.chunk(source.text);
      if (chunks.length === 0) continue;

      const embeddings = await this.embedding.embedBatch(chunks.map((c) => c.text));

      chunks.forEach((chunk, i) => {
        rows.push({
          userId,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          chunkIndex: chunk.index,
          text: chunk.text,
          metadata: source.metadata,
          embedding: embeddings[i],
          tokenCount: Math.ceil(chunk.text.length / 4),
          sourcePriority: SOURCE_PRIORITY[source.sourceType],
          sourceCreatedAt: source.sourceCreatedAt,
        });
      });
    }

    await this.prisma.client.$transaction([
      this.prisma.client.aiEmbeddingChunk.deleteMany({ where: { userId } }),
      ...(rows.length > 0 ? [this.prisma.client.aiEmbeddingChunk.createMany({ data: rows })] : []),
    ]);

    const sourceCounts: Record<string, number> = {};
    for (const source of sources) {
      sourceCounts[source.sourceType] = (sourceCounts[source.sourceType] ?? 0) + 1;
    }

    return { chunksIndexed: rows.length, sourceCounts };
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
      const text = [doc.summary, doc.ocrText].filter(Boolean).join("\n\n");
      if (!text.trim()) continue;
      sources.push({
        sourceType: "DOCUMENT",
        sourceId: doc.id,
        text,
        metadata: { title: doc.fileName, category: doc.category, tags: doc.tags },
        sourceCreatedAt: doc.createdAt,
      });
    }

    for (const interaction of coachInteractions) {
      sources.push({
        sourceType: "COACH_INTERACTION",
        sourceId: interaction.id,
        text: `Q: ${interaction.question}\nA: ${interaction.answer}`,
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

  private async safeDashboardSummary(userId: string) {
    try {
      return await this.dashboard.getSummary(userId);
    } catch (err) {
      this.logger.warn(`Skipping snapshot indexing for ${userId}: ${(err as Error).message}`);
      return null;
    }
  }
}

function reportToText(report: { month: string; income: string; expenses: string; netCashflow: string; savingsRate: number; expensesByCategory: { category: string; amount: string }[] }): string {
  const categoryLines = report.expensesByCategory.map((c) => `${c.category}: ${c.amount}`).join(", ");
  return (
    `Monthly report for ${report.month}. Income: ${report.income}. Expenses: ${report.expenses}. ` +
    `Net cashflow: ${report.netCashflow}. Savings rate: ${(report.savingsRate * 100).toFixed(1)}%. ` +
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
  insights: { title: string; detail: string }[];
}): string {
  const insightLines = summary.insights.map((i) => `${i.title}: ${i.detail}`).join("\n");
  return (
    `Current financial snapshot. Net worth: ${summary.netWorth}. Cash balance: ${summary.cashBalance}. ` +
    `Monthly income: ${summary.monthlyIncome}. Monthly expenses: ${summary.monthlyExpenses}. ` +
    `Savings rate: ${(summary.savingsRate * 100).toFixed(1)}%. Investments value: ${summary.investmentsValue}. ` +
    `Total debt: ${summary.totalDebt}. Property value: ${summary.propertyValue}.\n${insightLines}`
  );
}
