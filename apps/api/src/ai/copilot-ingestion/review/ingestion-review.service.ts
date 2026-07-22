import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { ExpensesService } from "../../../expenses/expenses.service";
import { PaymentMethod } from "@wealthos/db";

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
  constructor(
    private prisma: PrismaService,
    private expenses: ExpensesService,
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

  private async getOwnedPendingItem(userId: string, itemId: string) {
    const item = await this.prisma.client.ingestionReviewItem.findUnique({ where: { id: itemId } });
    if (!item || item.userId !== userId) throw new NotFoundException("Review item not found");
    if (item.status !== "PENDING") throw new BadRequestException(`This item is already ${item.status.toLowerCase()}`);
    return item;
  }
}
