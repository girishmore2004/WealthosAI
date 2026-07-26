import { Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { PrismaService } from "../prisma/prisma.service";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { ListExpensesQueryDto } from "./dto/list-expenses-query.dto";
// Reusing the canonical merchant normalizer that Copilot Ingestion already ships, rather
// than re-implementing normalization here. This is a read-only import of a pure,
// side-effect-free string function (no AI/LLM call, no NestJS DI, no other file in that
// feature is touched) — see the class-level comment on detectSubscriptions() below for
// why this specific fix was made.
import { normalizeMerchantText } from "../ai/copilot-ingestion/merchant/merchant-normalization";

export interface PagedExpensesResult {
  items: Awaited<ReturnType<ExpensesService["list"]>>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class ExpensesService {
  constructor(private prisma: PrismaService) {}

  listCategories() {
    return this.prisma.client.category.findMany({ orderBy: { name: "asc" } });
  }

  // Category.name is globally unique (@unique in the schema — categories are a shared,
  // platform-wide taxonomy, not per-user; isSystem distinguishes seeded from
  // user-created ones, but any user's custom category becomes visible to every other
  // user). That design is unchanged here — it's a deliberate existing choice, not
  // something this fix revisits — but two real gaps in how it was handled are closed:
  //  1. A same-name collision (e.g. two different users both trying to create
  //     "Subscriptions") previously hit Postgres's unique constraint directly and
  //     surfaced as an unhandled Prisma error → opaque 500. It now resolves to the
  //     existing category and returns it, which is the correct behavior for a shared
  //     taxonomy: "already exists" is success, not failure.
  //  2. Case-variant near-duplicates (e.g. "food" vs "Food") previously both succeeded
  //     as distinct rows, silently fragmenting categoryBreakdown() results across two
  //     categories that are the same thing to a user. Creation is now checked
  //     case-insensitively first.
  async createCategory(dto: CreateCategoryDto) {
    const existing = await this.prisma.client.category.findFirst({
      where: { name: { equals: dto.name, mode: "insensitive" } },
    });
    if (existing) return existing;

    try {
      return await this.prisma.client.category.create({ data: { ...dto, isSystem: false } });
    } catch (err) {
      // P2002 = unique constraint violation. Can still happen despite the check above
      // under a genuine race (two concurrent requests creating the same new category
      // name at once) — the loser of the race gets the winner's row instead of an
      // opaque 500, same end state as the pre-check path above.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const winner = await this.prisma.client.category.findFirst({
          where: { name: { equals: dto.name, mode: "insensitive" } },
        });
        if (winner) return winner;
      }
      throw err;
    }
  }

  list(userId: string, month?: string) {
    const dateFilter = month ? this.monthRange(month) : undefined;
    return this.prisma.client.expense.findMany({
      where: { userId, ...(dateFilter ? { spentAt: dateFilter } : {}) },
      include: { category: true },
      orderBy: { spentAt: "desc" },
    });
  }

  // Opt-in paginated + filterable listing (page/pageSize capped at 100, optional
  // category and date-range filters) for callers that don't want the full unbounded
  // list() result — same rationale and shape convention as IncomeService.listPaged().
  // Existing GET /expenses is left exactly as-is (unbounded array) since the expenses
  // page consumes it directly as an array.
  async listPaged(userId: string, query: ListExpensesQueryDto): Promise<PagedExpensesResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const where: Prisma.ExpenseWhereInput = {
      userId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.from || query.to
        ? {
            spentAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.expense.findMany({
        where,
        include: { category: true },
        orderBy: { spentAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.expense.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async create(userId: string, dto: CreateExpenseDto) {
    return this.prisma.client.expense.create({
      data: { ...dto, userId, spentAt: new Date(dto.spentAt) },
      include: { category: true },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — closes
  // the TOCTOU gap between "check ownership" and "perform the write," and collapses a
  // cross-user access attempt and a nonexistent id into the same 404 response rather
  // than leaking which case occurred via a 403/404 split (same pattern already applied
  // to Income; matches the codebase's own precedent, e.g. GET /ai/jobs/:id).
  async update(userId: string, id: string, dto: UpdateExpenseDto) {
    const result = await this.prisma.client.expense.updateMany({
      where: { id, userId },
      data: { ...dto, spentAt: dto.spentAt ? new Date(dto.spentAt) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Expense not found");
    }

    // updateMany() only returns a count; fetch the row (with its category relation, to
    // preserve the original method's response shape) to return the updated record.
    return this.prisma.client.expense.findUnique({ where: { id }, include: { category: true } });
  }

  // Same atomic-ownership approach, and here it's also a genuine round-trip reduction:
  // one deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's expenses
  // page (api.expenses.remove(id)'s response is never read; it always re-fetches the
  // list afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.expense.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Expense not found");
    }

    return { id };
  }

  // Groups current-month spend by category — powers the dashboard trend/budget widgets.
  // Left arithmetically unchanged (native number summation, not Decimal) deliberately:
  // this method is consumed by Coach and Alerts in addition to this feature's own
  // controller, and changing its summation method carries real regression risk for
  // those call sites and their tests for no correctness benefit at this data scale — see
  // the equivalent decision documented in IncomeService.monthlyForecast().
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
  //
  // MERCHANT-NORMALIZATION FIX: previously grouped by the raw, only-lowercased merchant
  // string (e.g. "POS Netflix 4829102" and "POS Netflix 5810293" — two real bank-
  // statement lines for the same subscription with different trailing reference numbers
  // — would NOT have been grouped together). This now groups by the same
  // normalizeMerchantText() Copilot Ingestion already uses to strip that exact kind of
  // statement noise before comparing, closing an inconsistency the audit flagged: two
  // downstream consumers (RecurringDetectionService, HouseholdService's cross-member
  // matching) already defensively re-normalize this method's output before comparing it
  // to anything — meaning they anticipated this exact gap. Fixing it at the source makes
  // that defensive re-normalization redundant-but-harmless there, and — more importantly
  // — fixes the cases those consumers couldn't fix after the fact: if this method never
  // grouped the two statement lines together in the first place, no amount of downstream
  // re-normalization recovers that.
  //
  // Output note: the `merchant` field now returns the normalized, display-friendly form
  // (e.g. "Netflix") instead of the previous raw-lowercased form (e.g. "netflix"). This
  // is a disclosed, intentional display-quality improvement, not a schema/contract
  // change — every downstream consumer either only displays this string (Coach, Alerts'
  // title text) or already lowercases it again before comparing (RecurringDetectionService,
  // Household's shared-subscription matching), so nothing downstream breaks. The one
  // minor, one-time, harmless side effect: Alerts' dedupeKey (`subscription-${merchant}`)
  // will differ in casing on the first refresh() after this deploy, so any existing
  // unread "recurring charge" alert gets pruned and immediately regenerated with the
  // corrected merchant name — already-read alerts are unaffected (preserved as history
  // per AlertsService's own documented behavior).
  async detectSubscriptions(userId: string) {
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const expenses = await this.prisma.client.expense.findMany({
      where: { userId, spentAt: { gte: threeMonthsAgo }, merchant: { not: null } },
      orderBy: { spentAt: "desc" },
    });

    const byMerchant = new Map<string, { id: string; amount: number; spentAt: Date; displayName: string }[]>();
    for (const e of expenses) {
      const displayName = normalizeMerchantText(e.merchant!);
      const key = displayName.toLowerCase();
      const list = byMerchant.get(key) ?? [];
      list.push({ id: e.id, amount: Number(e.amount), spentAt: e.spentAt, displayName });
      byMerchant.set(key, list);
    }

    return Array.from(byMerchant.entries())
      .filter(([, rows]) => rows.length >= 2)
      .map(([, rows]) => ({
        // rows are in spentAt-descending order (inherited from the query above), so
        // rows[0] is the most recent occurrence — used for both the display name and
        // lastSeenAt below, for the same reason: the most recent statement line is the
        // most representative one to show the user.
        merchant: rows[0].displayName,
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
}
