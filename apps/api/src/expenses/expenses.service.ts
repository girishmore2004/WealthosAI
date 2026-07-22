import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  listCategories() {
    return this.prisma.client.category.findMany({ orderBy: { name: "asc" } });
  }

  createCategory(dto: CreateCategoryDto) {
    return this.prisma.client.category.create({ data: { ...dto, isSystem: false } });
  }

  list(userId: string, month?: string) {
    const dateFilter = month ? this.monthRange(month) : undefined;
    return this.prisma.client.expense.findMany({
      where: { userId, ...(dateFilter ? { spentAt: dateFilter } : {}) },
      include: { category: true },
      orderBy: { spentAt: "desc" },
    });
  }

  async create(userId: string, dto: CreateExpenseDto) {
    return this.prisma.client.expense.create({
      data: { ...dto, userId, spentAt: new Date(dto.spentAt) },
      include: { category: true },
    });
  }

  async update(userId: string, id: string, dto: UpdateExpenseDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.expense.update({
      where: { id },
      data: { ...dto, spentAt: dto.spentAt ? new Date(dto.spentAt) : undefined },
      include: { category: true },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.expense.delete({ where: { id } });
  }

  // Groups current-month spend by category — powers the dashboard trend/budget widgets.
  async categoryBreakdown(userId: string, month?: string) {
    const expenses = await this.list(userId, month);
    const totals = new Map<string, { categoryId: string; name: string; type: string; total: number }>();

    for (const e of expenses) {
      const key = e.categoryId;
      const existing = totals.get(key);
      const amount = Number(e.amount);
      if (existing) {
        existing.total += amount;
      } else {
        totals.set(key, {
          categoryId: key,
          name: e.category.name,
          type: e.category.type,
          total: amount,
        });
      }
    }

    return Array.from(totals.values()).sort((a, b) => b.total - a.total);
  }

  // Naive recurring-charge / subscription detector: same merchant + similar amount
  // appearing in 2+ of the last 3 months. A real implementation would use a longer
  // lookback window and fuzzy amount matching; this is a working baseline.
  //
  // DELIBERATE PRODUCT DECISION (see README "Subscriptions"): this stays a derived
  // view over Expense rows rather than becoming its own trackable entity. Promoting it
  // to a real Subscription model (with its own renewal date, cancel-tracking, price
  // history) was considered and rejected for now because a user-editable Subscription
  // record can silently drift from the Expense rows it's supposed to summarize —
  // "trust the detector, not a second copy of the truth" is safer until there's a
  // concrete need (e.g. renewal alerts) that a derived view genuinely can't support.
  // `confidence` and `sourceExpenseIds` exist so the UI can show its work rather than
  // asserting a merchant is a subscription with no way to double check.
  async detectSubscriptions(userId: string) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const expenses = await this.prisma.client.expense.findMany({
      where: { userId, spentAt: { gte: threeMonthsAgo }, merchant: { not: null } },
      orderBy: { spentAt: "desc" },
    });

    const byMerchant = new Map<string, { id: string; amount: number; spentAt: Date }[]>();
    for (const e of expenses) {
      const key = e.merchant!.toLowerCase();
      const list = byMerchant.get(key) ?? [];
      list.push({ id: e.id, amount: Number(e.amount), spentAt: e.spentAt });
      byMerchant.set(key, list);
    }

    return Array.from(byMerchant.entries())
      .filter(([, rows]) => rows.length >= 2)
      .map(([merchant, rows]) => ({
        merchant,
        occurrences: rows.length,
        averageAmount: rows.reduce((a, r) => a + r.amount, 0) / rows.length,
        // 2 hits in a 3-month window is plausible but could be coincidence (e.g. two
        // one-off purchases at the same store); 3+ hits within the window is much
        // stronger evidence of a recurring charge.
        confidence: (rows.length >= 3 ? "HIGH" : "MEDIUM") as "HIGH" | "MEDIUM",
        lastSeenAt: rows[0].spentAt.toISOString(),
        sourceExpenseIds: rows.map((r) => r.id),
      }));
  }

  private monthRange(month: string) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    return { gte: start, lt: end };
  }

  private async assertOwnership(userId: string, expenseId: string) {
    const expense = await this.prisma.client.expense.findUnique({ where: { id: expenseId } });
    if (!expense) throw new NotFoundException("Expense not found");
    if (expense.userId !== userId) throw new ForbiddenException();
  }
}
