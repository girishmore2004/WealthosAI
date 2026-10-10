import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ExpenseFlowType, Prisma, Recurrence } from "@wealthos/db";
import type { ExpenseAnalyticsDTO, ExpenseComparisonDTO, ExpenseExtremeDTO, ExpensePeriodImpactDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { ExpenseSort, ListExpensesQueryDto } from "./dto/list-expenses-query.dto";
import { ExpenseAnalyticsQueryDto } from "./dto/expense-analytics-query.dto";
import { QuickExpenseDto } from "./dto/quick-expense.dto";
import { percentChange, percentOf, toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import {
  DateRange,
  ExpensePeriod,
  addDaysUtc,
  daysInRange,
  isoDay,
  parseToday,
  previousWindow,
  resolveCustomRange,
  resolveExpensePeriod,
  sameWindowLastYear,
  startOfWeekUtc,
  utcMidnight,
} from "./expense-period.util";
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

// Analytics returns one row per calendar day, so the span is bounded (≈3 years) — longer
// ranges should use the monthly buckets of several calls rather than one giant response.
const MAX_ANALYTICS_DAYS = 1100;
const ZERO = new Prisma.Decimal(0);

// 1-decimal percentage as a plain number (18.055… → 18.1); null stays null.
const pct1 = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()));

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

  // The SPENDING view: only flowType EXPENSE rows. Every consumer of this method (dashboard,
  // reports, coach, alerts, financial facts) therefore excludes OTHER_OUTFLOW rows from
  // "expenses" automatically, in one place, instead of each re-filtering. The paginated page
  // listing (listPaged) is the one that can show every kind of row.
  list(userId: string, month?: string) {
    const dateFilter = month ? this.monthRange(month) : undefined;
    return this.prisma.client.expense.findMany({
      where: { userId, flowType: "EXPENSE", ...(dateFilter ? { spentAt: dateFilter } : {}) },
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

    // A server-resolved preset (Today, This Week, Last Month …) wins over raw from/to.
    let spentAt: Prisma.DateTimeFilter | undefined;
    if (query.period && query.period !== "CUSTOM") {
      const r = resolveExpensePeriod(query.period as ExpensePeriod, parseToday(query.today));
      spentAt = { gte: r.from, lt: r.toExclusive };
    } else if (query.from || query.to) {
      spentAt = {
        ...(query.from ? { gte: new Date(query.from) } : {}),
        ...(query.to ? { lte: new Date(query.to) } : {}),
      };
    }

    const where: Prisma.ExpenseWhereInput = {
      userId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(spentAt ? { spentAt } : {}),
      ...(query.flowType ? { flowType: query.flowType } : {}),
      ...(query.paymentMethod ? { paymentMethod: query.paymentMethod } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.expense.findMany({
        where,
        include: { category: true },
        orderBy: this.orderBy(query.sort),
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

  // Expenses are ACTUAL SPENDING. SIPs, investment contributions and emergency-fund
  // allocations move money between buckets and are recorded as InvestmentCashflow /
  // EmergencyFundEntry, so the legacy SAVINGS category type is refused for NEW
  // expenses. Existing SAVINGS rows are preserved untouched (they are reconciled by
  // the legacy migration, never deleted).
  //
  // Shared by create() AND update(): previously only create() enforced this, so a row
  // created in a normal category could be PATCHed into a SAVINGS category and silently
  // bypass the rule (and then be excluded from expense totals as "legacy savings").
  async assertNotSavingsCategory(categoryId: string) {
    const category = await this.prisma.client.category.findUnique({
      where: { id: categoryId },
      select: { type: true, name: true },
    });
    if (!category) {
      throw new BadRequestException("Category not found");
    }
    if (category.type === "SAVINGS") {
      throw new BadRequestException(
        `"${category.name}" is a savings/investment category and cannot be used for an expense. ` +
          "Record SIPs and investments as investment contributions, and emergency-fund transfers as emergency allocations.",
      );
    }
  }

  // `recurrence` (optional) saves the expense AS the recurrence template in the same write:
  // the same fields POST /expenses/:id/recurrence/activate sets, so there is no window in which
  // the row exists but the "repeat" the user asked for was lost. Later occurrences are produced
  // by the recurrence engine, never created in advance.
  async create(
    userId: string,
    dto: CreateExpenseDto,
    recurrence?: { cadence: Exclude<Recurrence, "ONE_TIME">; endDate?: string },
  ) {
    await this.assertNotSavingsCategory(dto.categoryId);

    const spentAt = new Date(dto.spentAt);
    if (recurrence?.endDate && new Date(recurrence.endDate).getTime() < spentAt.getTime()) {
      throw new BadRequestException("The recurrence end date cannot be before the first expense date");
    }

    return this.prisma.client.expense.create({
      data: {
        ...dto,
        userId,
        spentAt,
        ...(recurrence
          ? {
              isRecurring: true,
              recurrence: recurrence.cadence,
              recurrenceActive: true,
              recurrenceEndDate: recurrence.endDate ? new Date(recurrence.endDate) : null,
              nextOccurrenceAt: spentAt,
            }
          : {}),
      },
      include: { category: true },
    });
  }

  // QUICK EXPENSE: a canonical Expense row (no separate "daily expense" store), saved with
  // sensible defaults — today's date, UPI — and returned together with the figures it just
  // changed so the UI can confirm "Today Grocery +₹500" without a second round trip.
  async quickCreate(userId: string, dto: QuickExpenseDto) {
    const cadence = dto.recurrence && dto.recurrence !== "ONE_TIME" ? dto.recurrence : undefined;
    if (dto.recurrenceEndDate && !cadence) {
      throw new BadRequestException("recurrenceEndDate needs a recurrence cadence");
    }

    const spentAt = dto.spentAt ?? isoDay(new Date());
    const expense = await this.create(
      userId,
      {
        categoryId: dto.categoryId,
        merchant: dto.merchant,
        amount: dto.amount,
        spentAt,
        paymentMethod: dto.paymentMethod ?? "UPI",
        notes: dto.notes,
        flowType: dto.flowType,
      },
      cadence ? { cadence, endDate: dto.recurrenceEndDate } : undefined,
    );

    const impact = await this.periodImpact(userId, expense.categoryId, new Date(spentAt), expense.flowType);
    return { expense, impact };
  }

  // GET /expenses/summary: today / this month / this year in one cheap call (three indexed
  // aggregates), so the expense page header does not need three full analytics requests.
  // `today` is the caller's local date (YYYY-MM-DD); ranges are UTC calendar days like everywhere else.
  async periodTotals(userId: string, todayStr: string | undefined, flowType: ExpenseFlowType = "EXPENSE") {
    const today = parseToday(todayStr);
    const ranges = {
      today: resolveExpensePeriod("TODAY", today),
      month: resolveExpensePeriod("THIS_MONTH", today),
      year: resolveExpensePeriod("THIS_YEAR", today),
    };
    const sum = async (r: DateRange) => {
      const agg = await this.prisma.client.expense.aggregate({ where: this.spendingWhere(userId, r, flowType), _sum: { amount: true } });
      return toMoneyString(toDecimal(agg._sum.amount));
    };
    const [todayTotal, monthTotal, yearTotal] = await Promise.all([sum(ranges.today), sum(ranges.month), sum(ranges.year)]);
    return { basis: "ACTUAL" as const, currency: "INR", date: isoDay(today), flowType, today: todayTotal, month: monthTotal, year: yearTotal };
  }

  // Recurring vs one-time spending over [from, toExclusive). "Recurring" = a row that is flagged as
  // recurring, is the template of a recurrence rule, or was generated from one. Same filters as the
  // analytics endpoint (flow type EXPENSE, legacy SAVINGS rows out), so recurring + oneTime always
  // equals the analytics total for the same window.
  async recurringSplit(userId: string, from: Date, toExclusive: Date) {
    const range: DateRange = { from, toExclusive };
    const base = this.spendingWhere(userId, range, "EXPENSE");
    const recurringClause: Prisma.ExpenseWhereInput = {
      OR: [{ isRecurring: true }, { recurrence: { not: null } }, { generatedFromRecurringId: { not: null } }],
    };
    const [all, recurring] = await Promise.all([
      this.prisma.client.expense.aggregate({ where: base, _sum: { amount: true } }),
      this.prisma.client.expense.aggregate({ where: { AND: [base, recurringClause] }, _sum: { amount: true } }),
    ]);
    const total = toDecimal(all._sum.amount);
    const rec = toDecimal(recurring._sum.amount);
    const percent = percentOf(rec, total);
    return {
      recurring: toMoneyString(rec),
      oneTime: toMoneyString(total.minus(rec)),
      recurringPercent: percent === null ? null : Number(percent.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()),
    };
  }

  // The biggest individual expenses in [from, toExclusive), largest first (ties: newest first).
  async largestTransactions(userId: string, from: Date, toExclusive: Date, limit = 5): Promise<ExpenseExtremeDTO[]> {
    const rows = await this.prisma.client.expense.findMany({
      where: this.spendingWhere(userId, { from, toExclusive }, "EXPENSE"),
      orderBy: [{ amount: "desc" }, { spentAt: "desc" }],
      take: Math.min(Math.max(limit, 1), 20),
      include: { category: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      amount: toMoneyString(toDecimal(r.amount)),
      spentAt: r.spentAt.toISOString(),
      merchant: r.merchant ?? null,
      categoryName: r.category.name,
    }));
  }

  // What a just-saved expense changed: that category's and ALL categories' totals for the
  // expense's own day, month and year (UTC calendar). Same filters as the analytics endpoint
  // (flow type, legacy SAVINGS rows excluded), so these numbers always agree with it.
  async periodImpact(userId: string, categoryId: string, date: Date, flowType: ExpenseFlowType = "EXPENSE"): Promise<ExpensePeriodImpactDTO> {
    const day = utcMidnight(date);
    const ranges: Record<"day" | "month" | "year", DateRange> = {
      day: { from: day, toExclusive: addDaysUtc(day, 1) },
      month: { from: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1)), toExclusive: new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth() + 1, 1)) },
      year: { from: new Date(Date.UTC(day.getUTCFullYear(), 0, 1)), toExclusive: new Date(Date.UTC(day.getUTCFullYear() + 1, 0, 1)) },
    };
    const sum = async (r: DateRange, withCategory: boolean) => {
      const agg = await this.prisma.client.expense.aggregate({
        where: this.spendingWhere(userId, r, flowType, withCategory ? categoryId : undefined),
        _sum: { amount: true },
      });
      return toMoneyString(toDecimal(agg._sum.amount));
    };
    const [dayCat, dayAll, monthCat, monthAll, yearCat, yearAll] = await Promise.all([
      sum(ranges.day, true),
      sum(ranges.day, false),
      sum(ranges.month, true),
      sum(ranges.month, false),
      sum(ranges.year, true),
      sum(ranges.year, false),
    ]);
    return {
      basis: "ACTUAL",
      date: isoDay(day),
      flowType,
      day: { categoryTotal: dayCat, allCategoriesTotal: dayAll },
      month: { categoryTotal: monthCat, allCategoriesTotal: monthAll },
      year: { categoryTotal: yearCat, allCategoriesTotal: yearAll },
    };
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — closes
  // the TOCTOU gap between "check ownership" and "perform the write," and collapses a
  // cross-user access attempt and a nonexistent id into the same 404 response rather
  // than leaking which case occurred via a 403/404 split (same pattern already applied
  // to Income; matches the codebase's own precedent, e.g. GET /ai/jobs/:id).
  async update(userId: string, id: string, dto: UpdateExpenseDto) {
    // Only re-validated when the caller is actually changing the category, so ordinary
    // edits (merchant, notes, amount) cost no extra query.
    if (dto.categoryId !== undefined) {
      await this.assertNotSavingsCategory(dto.categoryId);
    }

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
      where: { userId, flowType: "EXPENSE", spentAt: { gte: threeMonthsAgo }, merchant: { not: null } },
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

  // ---- filters / sorting -----------------------------------------------------------------

  // Newest is the default. A createdAt tiebreaker keeps page boundaries stable when several
  // expenses share a date (otherwise rows can repeat or vanish between pages).
  private orderBy(sort?: ExpenseSort): Prisma.ExpenseOrderByWithRelationInput[] {
    switch (sort) {
      case "OLDEST":
        return [{ spentAt: "asc" }, { createdAt: "asc" }];
      case "HIGHEST":
        return [{ amount: "desc" }, { spentAt: "desc" }];
      case "LOWEST":
        return [{ amount: "asc" }, { spentAt: "desc" }];
      default:
        return [{ spentAt: "desc" }, { createdAt: "desc" }];
    }
  }

  // The ONE definition of "an expense counts here": the user's rows, in the range, of the
  // requested flow type, excluding legacy SAVINGS-category rows (those are reconciled by the
  // legacy migration and are not spending).
  private spendingWhere(userId: string, r: DateRange, flowType: ExpenseFlowType, categoryId?: string): Prisma.ExpenseWhereInput {
    return {
      userId,
      flowType,
      spentAt: { gte: r.from, lt: r.toExclusive },
      category: { type: { not: "SAVINGS" } },
      ...(categoryId ? { categoryId } : {}),
    };
  }

  private resolveRange(period: string | undefined, from: string | undefined, to: string | undefined, today: Date): DateRange {
    if (period && period !== "CUSTOM") return resolveExpensePeriod(period as ExpensePeriod, today);
    if (from && to) return resolveCustomRange(from, to);
    if (period === "CUSTOM" || from || to) throw new BadRequestException("A custom range needs both from and to dates");
    return resolveExpensePeriod("THIS_MONTH", today);
  }

  // Per-day totals computed IN THE DATABASE (one grouped query), so a chart never requires
  // downloading transactions. Dates bucket on the UTC calendar day, matching how expense dates
  // are stored.
  private async dailyTotals(userId: string, r: DateRange, flowType: ExpenseFlowType, categoryId?: string) {
    const categorySql = categoryId ? Prisma.sql`AND e."categoryId" = ${categoryId}` : Prisma.empty;
    return this.prisma.client.$queryRaw<Array<{ day: Date; total: Prisma.Decimal; count: number }>>(Prisma.sql`
      SELECT (e."spentAt" AT TIME ZONE 'UTC')::date AS day,
             SUM(e."amount") AS total,
             COUNT(*)::int AS count
      FROM "Expense" e
      JOIN "Category" c ON c."id" = e."categoryId"
      WHERE e."userId" = ${userId}
        AND e."spentAt" >= ${r.from}
        AND e."spentAt" < ${r.toExclusive}
        AND e."flowType" = ${flowType}::"ExpenseFlowType"
        AND c."type" <> 'SAVINGS'
        ${categorySql}
      GROUP BY 1
      ORDER BY 1
    `);
  }

  // ---- analytics ---------------------------------------------------------------------------
  //
  // GET /expenses/analytics. Everything is aggregated in Postgres and only aggregates come back
  // (a daily series, category totals, two extreme transactions) — never the transaction list.
  // Powers the expense summary, the category drill-down (pass categoryId) and the trend charts.
  async analytics(userId: string, query: ExpenseAnalyticsQueryDto): Promise<ExpenseAnalyticsDTO> {
    const today = parseToday(query.today);
    const range = this.resolveRange(query.period, query.from, query.to, today);
    const days = daysInRange(range);
    if (days > MAX_ANALYTICS_DAYS) {
      throw new BadRequestException(`The date range is too long (${days} days); the maximum is ${MAX_ANALYTICS_DAYS}.`);
    }

    const flowType: ExpenseFlowType = query.flowType ?? "EXPENSE";
    const categoryId = query.categoryId;
    const whereFor = (r: DateRange, withCategory = true) => this.spendingWhere(userId, r, flowType, withCategory ? categoryId : undefined);
    const previous = previousWindow(range);
    const lastYear = sameWindowLastYear(range);
    const sumOnly = { _sum: { amount: true } } as const;
    const withCategory = { category: { select: { name: true } } } as const;

    const [agg, largest, smallest, dailyRows, categoryGroups, previousAgg, lastYearAgg, overallAgg, previousCategoryGroups] = await Promise.all([
      this.prisma.client.expense.aggregate({ where: whereFor(range), _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.client.expense.findFirst({ where: whereFor(range), orderBy: [{ amount: "desc" }, { spentAt: "desc" }], include: withCategory }),
      this.prisma.client.expense.findFirst({ where: whereFor(range), orderBy: [{ amount: "asc" }, { spentAt: "desc" }], include: withCategory }),
      this.dailyTotals(userId, range, flowType, categoryId),
      this.prisma.client.expense.groupBy({ by: ["categoryId"], where: whereFor(range), _sum: { amount: true }, _count: { _all: true } }),
      this.prisma.client.expense.aggregate({ where: whereFor(previous), ...sumOnly }),
      this.prisma.client.expense.aggregate({ where: whereFor(lastYear), ...sumOnly }),
      // With a category filter, also the all-category total so "share of total expenses" is real.
      categoryId ? this.prisma.client.expense.aggregate({ where: whereFor(range, false), ...sumOnly }) : Promise.resolve(null),
      // Same grouping over the comparison window, so every category row can show its own change.
      this.prisma.client.expense.groupBy({ by: ["categoryId"], where: whereFor(previous), _sum: { amount: true } }),
    ]);
    const previousByCategory = new Map(previousCategoryGroups.map((g) => [g.categoryId, toDecimal(g._sum.amount)]));

    const total = toDecimal(agg._sum.amount);
    const count = agg._count._all;

    // Daily series, zero-filled for charts, but never into the future (those days haven't happened).
    const lastDay = new Date(Math.min(addDaysUtc(range.toExclusive, -1).getTime(), today.getTime()));
    const byDay = new Map(dailyRows.map((r) => [isoDay(r.day), r]));
    const daily: Array<{ date: string; total: Prisma.Decimal; count: number }> = [];
    for (let d = range.from; d.getTime() <= lastDay.getTime(); d = addDaysUtc(d, 1)) {
      const row = byDay.get(isoDay(d));
      daily.push({ date: isoDay(d), total: row ? toDecimal(row.total) : ZERO, count: row ? row.count : 0 });
    }

    // Days that actually had spending. Highest/lowest are chosen among these (a ₹0 day is "no spending").
    const spendDays = daily.filter((d) => d.count > 0);
    let highestDay: (typeof daily)[number] | null = null;
    let lowestDay: (typeof daily)[number] | null = null;
    for (const d of spendDays) {
      if (!highestDay || d.total.gt(highestDay.total)) highestDay = d;
      if (!lowestDay || d.total.lt(lowestDay.total)) lowestDay = d;
    }

    // Weekly (Monday-start) and monthly buckets are folded from the already-aggregated daily rows.
    const weekly = new Map<string, { total: Prisma.Decimal; count: number }>();
    const monthly = new Map<string, { total: Prisma.Decimal; count: number }>();
    const bump = (m: Map<string, { total: Prisma.Decimal; count: number }>, key: string, d: { total: Prisma.Decimal; count: number }) => {
      const cur = m.get(key) ?? { total: ZERO, count: 0 };
      m.set(key, { total: cur.total.plus(d.total), count: cur.count + d.count });
    };
    for (const d of daily) {
      const date = new Date(`${d.date}T00:00:00.000Z`);
      bump(weekly, isoDay(startOfWeekUtc(date)), d);
      bump(monthly, d.date.slice(0, 7), d);
    }

    // Average per day divides by the days that have ELAPSED in the range (a month in progress is
    // not diluted by its future days); never by less than 1.
    const elapsedDays = Math.max(1, Math.min(days, Math.round((today.getTime() - range.from.getTime()) / 86_400_000) + 1));

    const categoryIds = categoryGroups.map((g) => g.categoryId);
    const categories = categoryIds.length
      ? await this.prisma.client.category.findMany({ where: { id: { in: categoryIds } }, select: { id: true, name: true, type: true, icon: true } })
      : [];
    const categoryById = new Map(categories.map((c) => [c.id, c]));

    const extreme = (row: (NonNullable<typeof largest>) | null): ExpenseExtremeDTO | null =>
      row
        ? { id: row.id, amount: toMoneyString(toDecimal(row.amount)), spentAt: row.spentAt.toISOString(), merchant: row.merchant, categoryName: row.category.name }
        : null;

    const compare = (r: DateRange, a: { _sum: { amount: Prisma.Decimal | null } }): ExpenseComparisonDTO => {
      const prevTotal = toDecimal(a._sum.amount);
      return {
        from: isoDay(r.from),
        to: isoDay(addDaysUtc(r.toExclusive, -1)),
        total: toMoneyString(prevTotal),
        change: toMoneyString(total.minus(prevTotal)),
        changePercent: pct1(percentChange(total, prevTotal)),
      };
    };
    const lastYearTotal = toDecimal(lastYearAgg._sum.amount);

    return {
      basis: "ACTUAL",
      currency: "INR",
      period: { from: isoDay(range.from), to: isoDay(addDaysUtc(range.toExclusive, -1)), days, elapsedDays },
      filters: { categoryId: categoryId ?? null, flowType },
      totals: {
        total: toMoneyString(total),
        transactionCount: count,
        averagePerTransaction: count > 0 ? toMoneyString(total.div(count)) : null,
        averagePerDay: toMoneyString(total.div(elapsedDays)),
        largest: extreme(largest),
        smallest: extreme(smallest),
      },
      highestDay: highestDay ? { date: highestDay.date, total: toMoneyString(highestDay.total) } : null,
      lowestDay: lowestDay ? { date: lowestDay.date, total: toMoneyString(lowestDay.total) } : null,
      daily: daily.map((d) => ({ date: d.date, total: toMoneyString(d.total), count: d.count })),
      weekly: [...weekly.entries()].map(([weekStart, v]) => ({ weekStart, total: toMoneyString(v.total), count: v.count })),
      monthly: [...monthly.entries()].map(([month, v]) => ({ month, total: toMoneyString(v.total), count: v.count })),
      categories: categoryGroups
        .map((g) => {
          const c = categoryById.get(g.categoryId);
          const catTotal = toDecimal(g._sum.amount);
          const catPrevious = previousByCategory.get(g.categoryId) ?? ZERO;
          return {
            categoryId: g.categoryId,
            name: c?.name ?? "Unknown",
            type: c?.type ?? "NEED",
            icon: c?.icon ?? null,
            total: catTotal,
            count: g._count._all,
            sharePercent: pct1(percentOf(catTotal, total)),
            previousTotal: catPrevious,
            changePercent: pct1(percentChange(catTotal, catPrevious)),
          };
        })
        .sort((a, b) => b.total.comparedTo(a.total))
        .map((c) => ({ ...c, total: toMoneyString(c.total), previousTotal: toMoneyString(c.previousTotal) })),
      comparison: compare(previous, previousAgg),
      // Year-over-year only when the same window a year ago actually had spending.
      yearOverYear: lastYearTotal.gt(0) ? compare(lastYear, lastYearAgg) : null,
      overall: overallAgg
        ? { total: toMoneyString(toDecimal(overallAgg._sum.amount)), sharePercent: pct1(percentOf(total, toDecimal(overallAgg._sum.amount))) }
        : null,
    };
  }

  private monthRange(month: string) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    end.setMonth(end.getMonth() + 1);
    return { gte: start, lt: end };
  }
}
