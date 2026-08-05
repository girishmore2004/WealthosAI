import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ExpensesService } from "../../expenses/expenses.service";
import { FeatureExtractionService, ExpenseTransactionPoint } from "../ml-insights/features/feature-extraction.service";
import { parseStatementText, ParsedLine } from "./parsing/statement-parser";
import { StatementUnderstandingService } from "./parsing/statement-understanding.service";
import { StatementOcrAdapter } from "./parsing/statement-ocr.adapter";
import { OcrQualityEstimationService } from "./parsing/ocr-quality-estimation.service";
import { normalizeMerchantText } from "./merchant/merchant-normalization";
import { CategorySuggestionService } from "./merchant/category-suggestion.service";
import { DuplicateDetectionService, ExistingExpenseForDupeCheck } from "./detection/duplicate-detection.service";
import { RecurringDetectionService, SubscriptionCandidate } from "./detection/recurring-detection.service";
import { AnomalyFlaggingService } from "./detection/anomaly-flagging.service";
import { SuggestionScoringService } from "./scoring/suggestion-scoring.service";
import { ReconciliationService, TransactionKind } from "./reconciliation/reconciliation.service";
import { scrubPii } from "./privacy/pii-scrub.util";
import { SuggestionSource } from "./scoring/category-ranking.model";
import { PaymentMethod } from "@wealthos/db";

const MAX_RAW_TEXT_EXCERPT_CHARS = 4000;
// Bounds how many lines a single ingest() call will run the (per-line) AI category
// suggestion call for — protects Groq quota/latency on a very large pasted statement.
// A statement longer than this is expected to be split into smaller imports.
const MAX_LINES_PER_BATCH = 200;

/** Determines which of the deterministic parser's leftover lines are actually sent to
 * the AI statement-understanding fallback (`StatementUnderstandingService`).
 *
 * MAX_LINES_PER_BATCH must be a real pre-call guardrail on AI cost/latency exposure —
 * not just a post-hoc truncation of the final result. A statement where most lines
 * fail the deterministic parser (e.g. an unusual export format) would otherwise send
 * its entire, potentially far-larger-than-200-line unparsed set to a single AI
 * `extract` call before any cap was applied — exactly the unbounded-cost scenario
 * MAX_LINES_PER_BATCH exists to prevent. Lines beyond the remaining capacity are
 * simply never offered to the model — they surface to the user as unparsed, the same
 * outcome as an AI call that fails on them, just without paying for the call. */
export function capLinesForAiFallback(
  deterministicallyParsedCount: number,
  unparsedLines: string[],
  maxLinesPerBatch: number,
): { linesForAiFallback: string[]; overflowLines: string[] } {
  const remainingCapacity = Math.max(0, maxLinesPerBatch - deterministicallyParsedCount);
  return {
    linesForAiFallback: unparsedLines.slice(0, remainingCapacity),
    overflowLines: unparsedLines.slice(remainingCapacity),
  };
}

export interface IngestReviewItemData {
  rawLine: string;
  parsedDate: Date;
  parsedAmount: number;
  merchantRaw: string;
  merchantNormalized: string;
  suggestedCategoryId: string | null;
  suggestedCategoryName: string | null;
  categorySuggestionConfidence: number;
  suggestionSource: SuggestionSource;
  merchantMemorySampleSize: number;
  isDuplicateCandidate: boolean;
  duplicateOfExpenseId: string | null;
  duplicateConfidence: number;
  isRecurringCandidate: boolean;
  recurringMatchMerchant: string | null;
  isAnomalyCandidate: boolean;
  anomalyZScore: number | null;
  transactionKind: TransactionKind;
  reconciliationNote: string | null;
  missingFields: string[];
  overallConfidence: number;
  rationale: string;
  needsActiveLearningReview: boolean;
}

@Injectable()
export class CopilotIngestionService {
  constructor(
    private prisma: PrismaService,
    private expenses: ExpensesService,
    private features: FeatureExtractionService,
    private understanding: StatementUnderstandingService,
    private ocrAdapter: StatementOcrAdapter,
    private ocrQuality: OcrQualityEstimationService,
    private categorySuggestion: CategorySuggestionService,
    private duplicateDetection: DuplicateDetectionService,
    private recurringDetection: RecurringDetectionService,
    private anomalyFlagging: AnomalyFlaggingService,
    private reconciliation: ReconciliationService,
    private scoring: SuggestionScoringService,
  ) {}

  async ingest(userId: string, sourceLabel: string, rawText: string, defaultPaymentMethod: PaymentMethod) {
    return this.ingestParsedText(userId, sourceLabel, rawText, defaultPaymentMethod, "TEXT", null);
  }

  /** Statement-image ingestion: runs the raw image through a self-contained Tesseract
   * pass (StatementOcrAdapter — see that file for why it doesn't reuse the Documents
   * module's OCR adapter), estimates how trustworthy the extraction was
   * (OcrQualityEstimationService), then feeds the OCR'd text through the exact same
   * deterministic-parse → AI-fallback → suggestion pipeline as a pasted-text import.
   * The OCR path never bypasses deterministic parsing/validation — an OCR'd line still
   * has to match the same statement-line shape as a pasted one to be deterministically
   * parsed; garbled OCR output simply falls through to "unparsed," the same as garbled
   * pasted text would. */
  async ingestFromOcr(userId: string, sourceLabel: string, fileBuffer: Buffer, mimeType: string, defaultPaymentMethod: PaymentMethod) {
    const ocrResult = await this.ocrAdapter.process(fileBuffer, mimeType);
    const { parsed: deterministicallyParsed } = parseStatementText(ocrResult.text);
    const totalOcrLines = ocrResult.text.split(/\r?\n/).filter((l) => l.trim().length > 0).length;

    const quality = this.ocrQuality.estimate({
      engineConfidence: ocrResult.engineConfidence,
      totalLines: totalOcrLines,
      deterministicallyParsedLines: deterministicallyParsed.length,
    });

    return this.ingestParsedText(userId, sourceLabel, ocrResult.text, defaultPaymentMethod, "OCR_IMAGE", quality.extractionConfidence);
  }

  private async ingestParsedText(
    userId: string,
    sourceLabel: string,
    rawText: string,
    defaultPaymentMethod: PaymentMethod,
    ingestionSource: "TEXT" | "OCR_IMAGE",
    ocrExtractionConfidence: number | null,
  ) {
    const { parsed: deterministicallyParsed, unparsedLines } = parseStatementText(rawText);

    // Cap how many leftover lines are actually offered to the AI fallback BEFORE
    // calling it — see capLinesForAiFallback() for why this must happen pre-call.
    const { linesForAiFallback } = capLinesForAiFallback(deterministicallyParsed.length, unparsedLines, MAX_LINES_PER_BATCH);

    const aiRecovered = await this.understanding.parseLeftoverLines(userId, linesForAiFallback);
    // Lines that were never offered to the AI fallback (because remaining capacity
    // was already exhausted) are still part of unparsedLines and not of aiRecovered,
    // so this subtraction correctly counts them as unparsed — same as before.
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
      items.push(
        await this.buildReviewItem(userId, line, categories, existingForDupeCheck, subscriptions, allTransactionPoints, defaultPaymentMethod, ocrExtractionConfidence),
      );
    }

    const batch = await this.prisma.client.ingestionBatch.create({
      data: {
        userId,
        sourceLabel,
        ingestionSource,
        ocrExtractionConfidence,
        // Raw text is scrubbed of obvious PII shapes before being persisted for audit
        // purposes — see privacy/pii-scrub.util.ts for why this is a separate,
        // narrower pass than the redaction the AI Gateway already applies to anything
        // actually sent to a model.
        rawTextExcerpt: scrubPii(rawText.slice(0, MAX_RAW_TEXT_EXCERPT_CHARS)),
        totalLines: rawText.split(/\r?\n/).filter((l) => l.trim().length > 0).length,
        parsedCount: allParsed.length,
        unparsedCount: stillUnparsedCount,
        items: {
          create: items.map((item) => ({
            userId,
            rawLine: scrubPii(item.rawLine),
            parsedDate: item.parsedDate,
            parsedAmount: item.parsedAmount,
            merchantRaw: scrubPii(item.merchantRaw),
            merchantNormalized: item.merchantNormalized,
            suggestedCategoryId: item.suggestedCategoryId,
            suggestedCategoryName: item.suggestedCategoryName,
            categorySuggestionConfidence: item.categorySuggestionConfidence,
            suggestionSource: item.suggestionSource,
            merchantMemorySampleSize: item.merchantMemorySampleSize,
            isDuplicateCandidate: item.isDuplicateCandidate,
            duplicateOfExpenseId: item.duplicateOfExpenseId,
            duplicateConfidence: item.duplicateConfidence,
            isRecurringCandidate: item.isRecurringCandidate,
            recurringMatchMerchant: item.recurringMatchMerchant,
            isAnomalyCandidate: item.isAnomalyCandidate,
            anomalyZScore: item.anomalyZScore,
            transactionKind: item.transactionKind,
            reconciliationNote: item.reconciliationNote,
            missingFields: item.missingFields,
            overallConfidence: item.overallConfidence,
            rationale: item.rationale,
            needsActiveLearningReview: item.needsActiveLearningReview,
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
    ocrExtractionConfidence: number | null,
  ): Promise<IngestReviewItemData> {
    const merchantNormalized = normalizeMerchantText(line.merchantRaw);

    const [categorySuggestion, duplicateResult, reconciliationResult] = await Promise.all([
      this.categorySuggestion.suggest(userId, merchantNormalized, categories),
      Promise.resolve(this.duplicateDetection.check(line, existingForDupeCheck)),
      this.reconciliation.classifyLine(userId, { merchantNormalized, amount: line.amount, date: line.date }),
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

    const hasReconciliationMismatch =
      reconciliationResult.transactionKind !== "EXPENSE" &&
      (reconciliationResult.matchedRecordId === null || (reconciliationResult.reconciliationNote?.includes("but the recorded EMI") ?? false));

    const score = this.scoring.score({
      categorySuggestionConfidence: categorySuggestion.confidence,
      isDuplicateCandidate: duplicateResult.isDuplicateCandidate,
      duplicateConfidence: duplicateResult.duplicateConfidence,
      isRecurringCandidate: recurringResult.isRecurringCandidate,
      isAnomalyCandidate: anomalyResult.isAnomalyCandidate,
      missingFields,
      merchantMemorySampleSize: categorySuggestion.memorySampleSize,
      ocrExtractionConfidence: ocrExtractionConfidence ?? undefined,
      hasReconciliationMismatch,
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
      suggestionSource: categorySuggestion.source,
      merchantMemorySampleSize: categorySuggestion.memorySampleSize,
      isDuplicateCandidate: duplicateResult.isDuplicateCandidate,
      duplicateOfExpenseId: duplicateResult.duplicateOfExpenseId,
      duplicateConfidence: duplicateResult.duplicateConfidence,
      isRecurringCandidate: recurringResult.isRecurringCandidate,
      recurringMatchMerchant: recurringResult.recurringMatchMerchant,
      isAnomalyCandidate: anomalyResult.isAnomalyCandidate,
      anomalyZScore: anomalyResult.anomalyZScore,
      transactionKind: reconciliationResult.transactionKind,
      reconciliationNote: reconciliationResult.reconciliationNote,
      missingFields,
      overallConfidence: score.overallConfidence,
      rationale: score.rationale,
      needsActiveLearningReview: score.needsActiveLearningReview,
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

  /** On-demand batch-level reconciliation report — see ReconciliationService for why
   * this is computed live rather than cached on the batch row. */
  async getReconciliationReport(userId: string, batchId: string) {
    const batch = await this.getBatch(userId, batchId);
    if (!batch) return null;
    return this.reconciliation.reconcileBatch(
      userId,
      batch.items.map((i) => ({
        rawLine: i.rawLine,
        merchantNormalized: i.merchantNormalized,
        parsedAmount: Number(i.parsedAmount),
        parsedDate: i.parsedDate,
        status: i.status,
      })),
    );
  }
}
