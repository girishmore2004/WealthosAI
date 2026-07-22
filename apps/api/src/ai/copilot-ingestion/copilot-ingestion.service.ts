import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ExpensesService } from "../../expenses/expenses.service";
import { FeatureExtractionService, ExpenseTransactionPoint } from "../ml-insights/features/feature-extraction.service";
import { parseStatementText, ParsedLine } from "./parsing/statement-parser";
import { StatementUnderstandingService } from "./parsing/statement-understanding.service";
import { normalizeMerchantText } from "./merchant/merchant-normalization";
import { CategorySuggestionService } from "./merchant/category-suggestion.service";
import { DuplicateDetectionService, ExistingExpenseForDupeCheck } from "./detection/duplicate-detection.service";
import { RecurringDetectionService, SubscriptionCandidate } from "./detection/recurring-detection.service";
import { AnomalyFlaggingService } from "./detection/anomaly-flagging.service";
import { SuggestionScoringService } from "./scoring/suggestion-scoring.service";
import { PaymentMethod } from "@wealthos/db";

const MAX_RAW_TEXT_EXCERPT_CHARS = 4000;
// Bounds how many lines a single ingest() call will run the (per-line) AI category
// suggestion call for — protects Groq quota/latency on a very large pasted statement.
// A statement longer than this is expected to be split into smaller imports.
const MAX_LINES_PER_BATCH = 200;

export interface IngestReviewItemData {
  rawLine: string;
  parsedDate: Date;
  parsedAmount: number;
  merchantRaw: string;
  merchantNormalized: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  categorySuggestionConfidence: number;
  isDuplicateCandidate: boolean;
  duplicateOfExpenseId: string | null;
  duplicateConfidence: number;
  isRecurringCandidate: boolean;
  recurringMatchMerchant: string | null;
  isAnomalyCandidate: boolean;
  anomalyZScore: number | null;
  missingFields: string[];
  overallConfidence: number;
  rationale: string;
}

@Injectable()
export class CopilotIngestionService {
  constructor(
    private prisma: PrismaService,
    private expenses: ExpensesService,
    private features: FeatureExtractionService,
    private understanding: StatementUnderstandingService,
    private categorySuggestion: CategorySuggestionService,
    private duplicateDetection: DuplicateDetectionService,
    private recurringDetection: RecurringDetectionService,
    private anomalyFlagging: AnomalyFlaggingService,
    private scoring: SuggestionScoringService,
  ) {}

  async ingest(userId: string, sourceLabel: string, rawText: string, defaultPaymentMethod: PaymentMethod) {
    const { parsed: deterministicallyParsed, unparsedLines } = parseStatementText(rawText);
    const aiRecovered = await this.understanding.parseLeftoverLines(userId, unparsedLines);
    const stillUnparsedCount = unparsedLines.length - aiRecovered.length;

    const allParsed = [...deterministicallyParsed, ...aiRecovered].slice(0, MAX_LINES_PER_BATCH);

    const [categories, existingExpenses, subscriptions, allTransactionPoints] = await Promise.all([
      this.expenses.listCategories(),
      this.expenses.list(userId) as unknown as Promise<{ id: string; merchant: string | null; amount: unknown; spentAt: Date }[]>,
      this.expenses.detectSubscriptions(userId) as unknown as Promise<SubscriptionCandidate[]>,
      this.features.transactionPoints(userId),
    ]);

    const existingForDupeCheck: ExistingExpenseForDupeCheck[] = existingExpenses.map((e) => ({
      id: e.id,
      merchant: e.merchant,
      amount: Number(e.amount),
      spentAt: e.spentAt,
    }));

    const items: IngestReviewItemData[] = [];
    for (const line of allParsed) {
      items.push(await this.buildReviewItem(userId, line, categories, existingForDupeCheck, subscriptions, allTransactionPoints, defaultPaymentMethod));
    }

    const batch = await this.prisma.client.ingestionBatch.create({
      data: {
        userId,
        sourceLabel,
        rawTextExcerpt: rawText.slice(0, MAX_RAW_TEXT_EXCERPT_CHARS),
        totalLines: rawText.split(/\r?\n/).filter((l) => l.trim().length > 0).length,
        parsedCount: allParsed.length,
        unparsedCount: stillUnparsedCount,
        items: {
          create: items.map((item) => ({
            userId,
            rawLine: item.rawLine,
            parsedDate: item.parsedDate,
            parsedAmount: item.parsedAmount,
            merchantRaw: item.merchantRaw,
            merchantNormalized: item.merchantNormalized,
            suggestedCategoryId: item.suggestedCategoryId,
            suggestedCategoryName: item.suggestedCategoryName,
            categorySuggestionConfidence: item.categorySuggestionConfidence,
            isDuplicateCandidate: item.isDuplicateCandidate,
            duplicateOfExpenseId: item.duplicateOfExpenseId,
            duplicateConfidence: item.duplicateConfidence,
            isRecurringCandidate: item.isRecurringCandidate,
            recurringMatchMerchant: item.recurringMatchMerchant,
            isAnomalyCandidate: item.isAnomalyCandidate,
            anomalyZScore: item.anomalyZScore,
            missingFields: item.missingFields,
            overallConfidence: item.overallConfidence,
            rationale: item.rationale,
          })),
        },
      },
      include: { items: true },
    });

    return batch;
  }

  private async buildReviewItem(
    userId: string,
    line: ParsedLine,
    categories: { id: string; name: string }[],
    existingForDupeCheck: ExistingExpenseForDupeCheck[],
    subscriptions: SubscriptionCandidate[],
    allTransactionPoints: ExpenseTransactionPoint[],
    defaultPaymentMethod: PaymentMethod,
  ): Promise<IngestReviewItemData> {
    const merchantNormalized = normalizeMerchantText(line.merchantRaw);

    const [categorySuggestion, duplicateResult] = await Promise.all([
      this.categorySuggestion.suggest(userId, merchantNormalized, categories),
      Promise.resolve(this.duplicateDetection.check(line, existingForDupeCheck)),
    ]);

    const recurringResult = this.recurringDetection.check(line, subscriptions);

    const anomalyResult = categorySuggestion.categoryId
      ? this.anomalyFlagging.check(
          { amount: line.amount },
          categorySuggestion.categoryId,
          allTransactionPoints.filter((t) => t.categoryId === categorySuggestion.categoryId),
        )
      : { isAnomalyCandidate: false, anomalyZScore: null };

    // Payment method can't be reliably determined from typical statement/OCR text
    // per-line — it's always defaulted from the batch-level input and always
    // disclosed as a missing/assumed field rather than silently guessed.
    const missingFields = ["paymentMethod (defaulted, not detected)"];
    if (!categorySuggestion.categoryId) missingFields.push("category (no confident suggestion)");

    const score = this.scoring.score({
      categorySuggestionConfidence: categorySuggestion.confidence,
      isDuplicateCandidate: duplicateResult.isDuplicateCandidate,
      duplicateConfidence: duplicateResult.duplicateConfidence,
      isRecurringCandidate: recurringResult.isRecurringCandidate,
      isAnomalyCandidate: anomalyResult.isAnomalyCandidate,
      missingFields,
    });

    return {
      rawLine: line.rawLine,
      parsedDate: line.date,
      parsedAmount: line.amount,
      merchantRaw: line.merchantRaw,
      merchantNormalized,
      suggestedCategoryId: categorySuggestion.categoryId,
      suggestedCategoryName: categorySuggestion.categoryName,
      categorySuggestionConfidence: categorySuggestion.confidence,
      isDuplicateCandidate: duplicateResult.isDuplicateCandidate,
      duplicateOfExpenseId: duplicateResult.duplicateOfExpenseId,
      duplicateConfidence: duplicateResult.duplicateConfidence,
      isRecurringCandidate: recurringResult.isRecurringCandidate,
      recurringMatchMerchant: recurringResult.recurringMatchMerchant,
      isAnomalyCandidate: anomalyResult.isAnomalyCandidate,
      anomalyZScore: anomalyResult.anomalyZScore,
      missingFields,
      overallConfidence: score.overallConfidence,
      rationale: score.rationale,
    };
  }

  async listBatches(userId: string, take = 20) {
    return this.prisma.client.ingestionBatch.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
      include: { _count: { select: { items: true } } },
    });
  }

  async getBatch(userId: string, batchId: string) {
    const batch = await this.prisma.client.ingestionBatch.findUnique({ where: { id: batchId }, include: { items: true } });
    if (!batch || batch.userId !== userId) return null;
    return batch;
  }
}
