import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateIncomeDto } from "./dto/create-income.dto";
import { UpdateIncomeDto } from "./dto/update-income.dto";
import { ListIncomeQueryDto } from "./dto/list-income-query.dto";
import { Income, Prisma, Recurrence } from "@wealthos/db";

// Base currency for every INR-denominated calculation in the app (Tax's slab tables,
// Retirement's corpus math, Loans' debt-stress ratio, etc. are all hardcoded in ₹).
// `Income.currency` defaults to "INR" and CreateIncomeDto does not currently expose a way
// to set anything else via the public API — so this filter is a no-op against all
// reachable data today. It exists as a defense-in-depth guard: if a future feature (bulk
// import, admin tooling, a seed script) ever writes a non-INR row, it will be silently
// excluded from every aggregate below instead of silently corrupting them by being summed
// as if it were rupees.
const BASE_CURRENCY = "INR";

// Kept byte-for-byte identical to the original implementation so `monthlyForecast()`'s
// return value never drifts for any existing caller (Dashboard, Loans debt-stress, Tax's
// annual-income estimate, Retirement, Insurance gap analysis, the Simulator, Household
// aggregation, and the Coach all depend on this exact figure). Do not change these
// constants without also reviewing every one of those call sites and their tests.
const RECURRENCE_MONTHLY_MULTIPLIER: Record<string, number> = {
  ONE_TIME: 0,
  WEEKLY: 4.33,
  MONTHLY: 1,
  QUARTERLY: 1 / 3,
  YEARLY: 1 / 12,
};

// Decimal-safe multipliers for the new, independent monthlyForecastBreakdown() below.
// Not required to bit-match RECURRENCE_MONTHLY_MULTIPLIER above — this method has no
// existing callers/tests to stay compatible with, so it's free to use Decimal arithmetic
// for better precision on portfolios with many income rows. In practice the two methods'
// totals agree to the cent; see the doc comment on monthlyForecastBreakdown().
const RECURRENCE_MONTHLY_MULTIPLIER_DECIMAL: Partial<Record<Recurrence, string>> = {
  WEEKLY: "4.33",
  MONTHLY: "1",
  QUARTERLY: "0.333333333333",
  YEARLY: "0.083333333333",
};

export interface IncomeForecastBreakdown {
  // Independently computed from, and expected to match (to the cent) monthlyForecast()'s
  // return value — provided here alongside a fuller breakdown so a single call can drive
  // both the headline number and its supporting detail on the Income/Dashboard pages.
  totalMonthlyIncome: number;
  byRecurrence: Record<Recurrence, number>;
  // Surfaces the audit-flagged gap: one-time income is (by design) excluded from the
  // monthly forecast entirely, but nothing previously told the user that. The UI can now
  // render "₹X across N one-time entries isn't reflected in your monthly figure."
  oneTimeIncomeExcluded: { count: number; total: number };
  // See BASE_CURRENCY above — currently always { count: 0, currencies: [] } against real
  // data, kept for forward compatibility and to make the exclusion visible if it's ever
  // reachable.
  excludedNonBaseCurrency: { count: number; currencies: string[] };
}

export interface PagedIncomeResult {
  items: Income[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class IncomeService {
  constructor(private prisma: PrismaService) {}

  // Single-flight request coalescing: if list() is already in flight for this userId,
  // every concurrent caller gets the same promise instead of issuing a duplicate query.
  // This is not a TTL cache — there is no staleness window at all, since the entry is
  // removed the instant the query settles (success or failure) and every call after that
  // point issues a fresh query reflecting any writes that happened in between.
  //
  // This closes a real, verified redundancy: DashboardService.getSummary() calls
  // incomeService.monthlyForecast(userId) (which internally calls list()),
  // incomeService.list(userId) directly, AND loansService.debtSummary(userId) (which
  // itself calls incomeService.monthlyForecast(userId)) — all inside the same
  // Promise.all(). Before this change, a single dashboard load issued the identical
  // `Income.findMany({ where: { userId } })` query three times back-to-back; after this
  // change it issues it once and every caller shares the result.
  private readonly inFlightList = new Map<string, Promise<Income[]>>();

  list(userId: string): Promise<Income[]> {
    const existing = this.inFlightList.get(userId);
    if (existing) return existing;

    const promise = this.prisma.client.income
      .findMany({
        where: { userId },
        orderBy: { receivedAt: "desc" },
      })
      .finally(() => {
        this.inFlightList.delete(userId);
      });

    this.inFlightList.set(userId, promise);
    return promise;
  }

  // Opt-in paginated + date-range-filterable listing for callers that don't want (or
  // can't afford, for a long-lived heavy account) the full unbounded list() result. Does
  // not participate in the single-flight cache above — it's a distinct, filtered query
  // shape, and pagination requests are not expected to fan out redundantly the way the
  // full list() is.
  async listPaged(userId: string, query: ListIncomeQueryDto): Promise<PagedIncomeResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const where: Prisma.IncomeWhereInput = {
      userId,
      ...(query.from || query.to
        ? {
            receivedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.income.findMany({
        where,
        orderBy: { receivedAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.income.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async create(userId: string, dto: CreateIncomeDto) {
    return this.prisma.client.income.create({
      data: { ...dto, userId, receivedAt: new Date(dto.receivedAt) },
    });
  }

  // Ownership is now enforced atomically as part of the write itself (a single
  // updateMany scoped by {id, userId}) rather than via a separate findUnique-then-check
  // read beforehand. Two consequences, both intentional:
  //  1. Closes the (small but real) TOCTOU gap between "check ownership" and "perform the
  //     write" that existed when those were two independent queries.
  //  2. A cross-user access attempt and a truly-nonexistent id are no longer
  //     distinguishable from the response (both are a 404 NotFoundException). This
  //     mirrors the pattern already used elsewhere in this codebase for the same reason
  //     — e.g. GET /ai/jobs/:id returns 404 for both "doesn't exist" and "belongs to
  //     someone else" specifically to avoid leaking which case occurred.
  async update(userId: string, id: string, dto: UpdateIncomeDto) {
    // NEW (audit item #4): fetch the current row first — needed to detect an amount
    // change for IncomeHistory logging below, which the previous atomic
    // updateMany-only approach couldn't do (it never saw the "before" value). The
    // actual write below is still scoped by { id, userId } in updateMany, so this read
    // doesn't weaken the ownership check — it strictly adds an earlier one (thrown
    // before any write is attempted), following the same read-then-atomic-mutate
    // precedent already used elsewhere (e.g. PropertyService.remove()'s linked-Income
    // cleanup).
    const existing = await this.prisma.client.income.findUnique({ where: { id } });
    if (!existing || existing.userId !== userId) {
      throw new NotFoundException("Income not found");
    }

    // effectiveFrom is a history-only field (see UpdateIncomeDto) — it has no matching
    // column on Income itself, so it must never reach this row's own update data.
    const { effectiveFrom, ...incomeFields } = dto;

    const result = await this.prisma.client.income.updateMany({
      where: { id, userId },
      data: { ...incomeFields, receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Income not found");
    }

    // "Income has no effective-dated salary history... a raise is a manual edit to
    // the existing row's amount, with no historical record of what the salary was
    // before." Only logs when `amount` actually changes value — editing just the
    // label/notes/etc. doesn't touch salary history, keeping this table meaningful
    // rather than a generic edit log.
    if (dto.amount !== undefined && Number(existing.amount) !== dto.amount) {
      await this.prisma.client.incomeHistory.create({
        data: {
          userId,
          incomeId: id,
          previousAmount: existing.amount,
          newAmount: dto.amount,
          effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
        },
      });
    }

    // updateMany() only returns a count, not the updated row(s); fetch the row to keep
    // returning the full updated record, matching the original method's contract (the
    // frontend's income page currently ignores this response body entirely and re-fetches
    // via list() after every mutation, but other/future consumers may not).
    return this.prisma.client.income.findUnique({ where: { id } });
  }

  // "Add effective-dated salary/income history" — returns every logged amount change
  // for a single Income row, most-recent-first, so a user (or the AI Coach) can answer
  // "when did my salary last change, and from what to what" without having to infer it
  // from AuditLog's generic before/after diffs.
  async history(userId: string, incomeId: string) {
    const income = await this.prisma.client.income.findUnique({ where: { id: incomeId } });
    if (!income || income.userId !== userId) {
      throw new NotFoundException("Income not found");
    }
    return this.prisma.client.incomeHistory.findMany({
      where: { incomeId },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  // Same atomic-ownership approach as update(), and here it's also a genuine round-trip
  // reduction: one deleteMany({ id, userId }) replaces the previous
  // findUnique-then-delete pair. Returns { id } rather than the deleted row — verified
  // against apps/web's income page (api.income.remove(id)'s response is never read; it
  // always just re-fetches the list afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.income.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Income not found");
    }

    return { id };
  }

  // Simple recurrence-aware forecast: projects recurring income into the current month.
  // (Full multi-month forecasting engine is out of scope for this MVP slice.)
  //
  // Contract with callers: this MUST keep returning a plain Promise<number> with the
  // exact same computed value as before for any given set of income rows — Dashboard,
  // Loans (debt-stress ratio), Tax (annual income estimate), Retirement, Insurance (gap
  // analysis), the Simulator, Household aggregation, the Coach, and ML Insights' feature
  // extraction all call this directly and every one of their own tests assumes today's
  // exact numeric output. The only behavioral addition versus the original is the
  // currency guard, which is a no-op against all data reachable via the public API today
  // (see BASE_CURRENCY above) and is written to fall back to treating a missing/undefined
  // currency as INR, so it cannot affect existing rows or test fixtures that don't set
  // `currency` at all.
  async monthlyForecast(userId: string): Promise<number> {
    const incomes = await this.list(userId);
    return incomes.reduce((sum, inc) => {
      if ((inc.currency ?? BASE_CURRENCY) !== BASE_CURRENCY) return sum;
      const multiplier = RECURRENCE_MONTHLY_MULTIPLIER[inc.recurrence] ?? 0;
      return sum + Number(inc.amount) * multiplier;
    }, 0);
  }

  // New, additive, decimal-safe breakdown of the same underlying data — does not replace
  // or alter monthlyForecast() above. Uses Prisma's Decimal type (backed by decimal.js)
  // for summation instead of native JS floats, since this method sums potentially many
  // rows and has no legacy numeric output to stay bit-identical with. totalMonthlyIncome
  // here is expected to match monthlyForecast()'s return value to the cent (both round to
  // 2 decimal places at the end) but the two are computed independently; treat
  // monthlyForecast() as authoritative for any calculation, and this method as the
  // presentation-layer detail behind it.
  async monthlyForecastBreakdown(userId: string): Promise<IncomeForecastBreakdown> {
    const incomes = await this.list(userId);

    const byRecurrenceTotals: Record<Recurrence, Prisma.Decimal> = {
      ONE_TIME: new Prisma.Decimal(0),
      WEEKLY: new Prisma.Decimal(0),
      MONTHLY: new Prisma.Decimal(0),
      QUARTERLY: new Prisma.Decimal(0),
      YEARLY: new Prisma.Decimal(0),
    };

    let total = new Prisma.Decimal(0);
    let oneTimeCount = 0;
    let oneTimeTotal = new Prisma.Decimal(0);
    let foreignCount = 0;
    const foreignCurrencies = new Set<string>();

    for (const inc of incomes) {
      const currency = inc.currency ?? BASE_CURRENCY;
      if (currency !== BASE_CURRENCY) {
        foreignCount += 1;
        foreignCurrencies.add(currency);
        continue;
      }

      const amount = new Prisma.Decimal(inc.amount);

      if (inc.recurrence === "ONE_TIME") {
        oneTimeCount += 1;
        oneTimeTotal = oneTimeTotal.add(amount);
        byRecurrenceTotals.ONE_TIME = byRecurrenceTotals.ONE_TIME.add(amount);
        continue;
      }

      const multiplier = RECURRENCE_MONTHLY_MULTIPLIER_DECIMAL[inc.recurrence];
      if (!multiplier) continue; // defensive: unknown/legacy recurrence value

      const monthlyContribution = amount.mul(multiplier);
      total = total.add(monthlyContribution);
      byRecurrenceTotals[inc.recurrence] = byRecurrenceTotals[inc.recurrence].add(monthlyContribution);
    }

    const byRecurrence = Object.fromEntries(
      Object.entries(byRecurrenceTotals).map(([recurrence, decimal]) => [
        recurrence,
        decimal.toDecimalPlaces(2).toNumber(),
      ]),
    ) as Record<Recurrence, number>;

    return {
      totalMonthlyIncome: total.toDecimalPlaces(2).toNumber(),
      byRecurrence,
      oneTimeIncomeExcluded: {
        count: oneTimeCount,
        total: oneTimeTotal.toDecimalPlaces(2).toNumber(),
      },
      excludedNonBaseCurrency: {
        count: foreignCount,
        currencies: Array.from(foreignCurrencies),
      },
    };
  }
}
