import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { ExpensesService } from "../../../expenses/expenses.service";
import { PaymentMethod } from "@wealthos/db";
import { MerchantMemoryService } from "../merchant/merchant-memory.service";
import { CategoryRankingModel, SuggestionSource } from "../scoring/category-ranking.model";

export interface ApprovalEdits {
  categoryId?: string;
  amount?: number;
  merchant?: string;
  paymentMethod?: PaymentMethod;
  spentAt?: string;
  notes?: string;
}

export type DuplicateResolution = "kept_both" | "skipped_duplicate" | "merged";

@Injectable()
export class IngestionReviewService {
  private readonly logger = new Logger(IngestionReviewService.name);

  constructor(
    private prisma: PrismaService,
    private expenses: ExpensesService,
    private merchantMemory: MerchantMemoryService,
    private ranking: CategoryRankingModel,
  ) {}

  async approve(userId: string, itemId: string, edits: ApprovalEdits = {}, duplicateResolution?: DuplicateResolution) {
    const item = await this.getOwnedPendingItem(userId, itemId);

    // Conflict resolution, made explicit rather than silently defaulted: an item the
    // system itself flagged as a likely repeat of existing manual data cannot be
    // approved without the human saying what to do about that conflict. This is the
    // literal "conflict resolution between model suggestions and existing manual
    // data" the roadmap asked for — a required decision point, not a heuristic.
    if (item.isDuplicateCandidate && !duplicateResolution) {
      throw new BadRequestException(
        `This item was flagged as a possible duplicate (${item.rationale}). Approve with duplicateResolution set to "kept_both", "skipped_duplicate", or "merged".`,
      );
    }

    if (duplicateResolution === "skipped_duplicate") {
      return this.prisma.client.ingestionReviewItem.update({
        where: { id: itemId },
        data: { status: "REJECTED", duplicateResolution, resolvedAt: new Date() },
      });
    }

    const categoryId = edits.categoryId ?? item.suggestedCategoryId;
    if (!categoryId) {
      throw new BadRequestException("No category suggestion was confident enough — categoryId must be provided explicitly to approve this item.");
    }

    if (duplicateResolution === "merged" && item.duplicateOfExpenseId) {
      const updated = await this.expenses.update(userId, item.duplicateOfExpenseId, {
        categoryId,
        amount: edits.amount ?? Number(item.parsedAmount),
        merchant: edits.merchant ?? item.merchantNormalized,
        paymentMethod: edits.paymentMethod,
        spentAt: edits.spentAt,
        notes: edits.notes,
      });
      await this.recordLearningFeedback(userId, item, categoryId);
      return this.prisma.client.ingestionReviewItem.update({
        where: { id: itemId },
        data: { status: "APPROVED", duplicateResolution, resolvedExpenseId: updated.id, resolvedAt: new Date() },
      });
    }

    const created = await this.expenses.create(userId, {
      categoryId,
      amount: edits.amount ?? Number(item.parsedAmount),
      merchant: edits.merchant ?? item.merchantNormalized,
      spentAt: edits.spentAt ?? item.parsedDate.toISOString(),
      paymentMethod: edits.paymentMethod ?? "OTHER",
      notes: edits.notes,
      isRecurring: item.isRecurringCandidate,
    });

    await this.recordLearningFeedback(userId, item, categoryId);

    return this.prisma.client.ingestionReviewItem.update({
      where: { id: itemId },
      data: {
        status: "APPROVED",
        duplicateResolution: duplicateResolution ?? null,
        resolvedExpenseId: created.id,
        resolvedAt: new Date(),
      },
    });
  }

  async reject(userId: string, itemId: string) {
    await this.getOwnedPendingItem(userId, itemId);
    return this.prisma.client.ingestionReviewItem.update({
      where: { id: itemId },
      data: { status: "REJECTED", resolvedAt: new Date() },
    });
  }

  /** The single write path for the whole learning feedback loop — deliberately only
   * reachable from a completed, human-approved expense creation/merge, never from an
   * unverified AI suggestion. Both merchant memory (MerchantMemoryService) and the
   * ranking model's per-source weights (CategoryRankingModel) learn from the same
   * ground truth: did the human keep the suggested category, or pick a different one.
   * Failure here is logged and swallowed rather than propagated — a learning-loop
   * write failing must never roll back or fail the expense that was already
   * successfully created/merged; the human's approval is the thing that matters. */
  private async recordLearningFeedback(userId: string, item: { suggestedCategoryId: string | null; suggestionSource: string; merchantNormalized: string }, finalCategoryId: string): Promise<void> {
    try {
      const category = await this.prisma.client.category.findUnique({ where: { id: finalCategoryId } });
      if (!category) return;

      const wasCorrect = item.suggestedCategoryId !== null && item.suggestedCategoryId === finalCategoryId;
      const source = item.suggestionSource as SuggestionSource;

      await Promise.all([
        this.merchantMemory.recordFeedback(userId, item.merchantNormalized, finalCategoryId, category.name),
        this.ranking.learnFromCorrection(userId, source, wasCorrect),
      ]);
    } catch (err) {
      this.logger.warn(`Learning feedback write failed (expense was still created/merged successfully): ${(err as Error).message}`);
    }
  }

  private async getOwnedPendingItem(userId: string, itemId: string) {
    const item = await this.prisma.client.ingestionReviewItem.findUnique({ where: { id: itemId } });
    if (!item || item.userId !== userId) throw new NotFoundException("Review item not found");
    if (item.status !== "PENDING") throw new BadRequestException(`This item is already ${item.status.toLowerCase()}`);
    return item;
  }
}
