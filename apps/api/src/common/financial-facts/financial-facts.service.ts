import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { IncomeService } from "../../income/income.service";
import { ExpensesService } from "../../expenses/expenses.service";
import { monthRange, currentMonthString, monthsBefore, validateMonthFormat } from "../utils/financial-period.util";
import { FinancialFactDTO, FinancialFactBasis, FinancialFactPeriod } from "@wealthos/types";
import { Prisma } from "@wealthos/db";
import {
  Dec,
  ZERO,
  CashflowTotals,
  CashflowType,
  EmergencyEntryType,
  addCashflow,
  computeCashModel,
  computeNetWorth,
  deriveInvestmentMetrics,
  emergencyAvailableCashDelta,
  emergencyCoverageMonths,
  emergencyReserveDelta,
  emptyCashflowTotals,
  expenseRate,
  investmentCashInflow,
  investmentCashOutflow,
  investmentRate,
  savingsRate,
  sumDecimals,
  toDecimal,
  toMoneyString,
} from "./financial-formulas";

const CURRENCY = "INR";

export interface EmergencyFundStatus {
  amount: number;
  // LEDGER = summed from EmergencyFundEntry rows (authoritative once any entry exists).
  basis: "LEDGER" | "GOAL" | "CATEGORY_LEGACY" | "NONE";
  monthsOfCoverage: number;
}

export interface DataHealthWarning {
  code: "INVESTMENT_AS_EXPENSE" | "EMERGENCY_AS_EXPENSE" | "STALE_INVESTMENT_VALUATION" | "MISSING_INVESTMENT_VALUATION";
  severity: "WARNING" | "INFO";
  message: string;
  count: number;
  amount?: string;
}

interface FactMeta {
  basis: FinancialFactBasis;
  period: FinancialFactPeriod;
  asOfDate: string;
  currency: string;
}

export interface FinancialPosition extends FactMeta {
  cash: { available: string; emergency: string; total: string };
  income: string;
  expenses: string;
  investmentContributions: string;
  investmentWithdrawals: string;
  investmentValue: string;
  property: string;
  loans: string;
  totalAssets: string;
  totalLiabilities: string;
  netWorth: string;
  dataHealth: DataHealthWarning[];
}

export interface MonthlyCashFlow extends FactMeta {
  month: string;
  income: string;
  expenses: string;
  investmentContributions: string;
  emergencyAllocations: string;
  netCashFlow: string;
  // Ratios: 0.25 means 25%. Null when income is zero. Format with formatRatioAsPercent().
  savingsRate: string | null;
  investmentRate: string | null;
  expenseRate: string | null;
  dataHealth: DataHealthWarning[];
}

export interface EmergencyCoverage extends FactMeta {
  emergencyCash: string;
  avgMonthlyEssentialExpenses: string;
  coverageMonths: string | null;
  monthsOfData: number;
}

// Stale if the latest valuation is older than this many days.
const STALE_VALUATION_DAYS = 120;

// Audit item #1 (the single highest-leverage finding): "Dashboard uses
// IncomeService.monthlyForecast() (recurrence-normalized, basis FORECAST); Reports uses a
// raw date-filtered sum (basis ACTUAL) — the two 'monthly income' figures diverge and
// nothing explains why." This service is the fix: one place that computes each canonical
// metric with an EXPLICIT, documented basis, instead of every consumer (Dashboard,
// Reports, Tax, Retirement, Simulator, Coach) independently re-deriving it.
//
// Deliberately additive and non-breaking, per the migration strategy: this does not
// replace IncomeService.monthlyForecast()/ExpensesService.list() (both keep working
// exactly as before for any existing caller) — it wraps them with basis metadata and is
// adopted gradually. Reports and Dashboard's emergency-fund calc are the first two
// consumers (this batch); Tax/Retirement/Simulator/Coach are a planned follow-up.
@Injectable()
export class FinancialFactsService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
    private expensesService: ExpensesService,
  ) {}

  // basis: FORECAST. Every non-ONE_TIME Income row normalized to its monthly-equivalent
  // and summed, regardless of whether a matching transaction was actually logged this
  // month — i.e. exactly what Dashboard has always shown as "monthly income". Wraps
  // IncomeService.monthlyForecast() rather than reimplementing it, so this can never
  // silently drift from that method's own (widely-depended-on) numeric output.
  async getForecastMonthlyIncome(userId: string): Promise<FinancialFactDTO> {
    const value = await this.incomeService.monthlyForecast(userId);
    return {
      metric: "forecastMonthlyIncome",
      value: value.toFixed(2),
      currency: CURRENCY,
      basis: "FORECAST",
      asOf: new Date().toISOString(),
      sourceTypes: ["Income"],
      confidence: "MEDIUM",
      explanationKey: "income.monthlyForecast",
    };
  }

  // basis: ACTUAL. Raw sum of Income rows whose receivedAt falls inside the given
  // calendar month's UTC-safe date range — i.e. exactly what Reports has always shown as
  // "this month's income". Defaults to the current month when omitted.
  async getActualMonthlyIncome(userId: string, month?: string): Promise<FinancialFactDTO> {
    validateMonthFormat(month);
    const targetMonth = month ?? currentMonthString();
    const { start, end } = monthRange(targetMonth);

    const incomes = await this.incomeService.list(userId);
    const value = incomes
      .filter((i) => i.receivedAt >= start && i.receivedAt < end)
      .reduce((sum, i) => sum + Number(i.amount), 0);

    return {
      metric: "actualMonthlyIncome",
      value: value.toFixed(2),
      currency: CURRENCY,
      basis: "ACTUAL",
      asOf: new Date().toISOString(),
      sourceTypes: ["Income"],
      confidence: "HIGH",
      explanationKey: "income.monthlyActual",
    };
  }

  // basis: ACTUAL. Raw sum of Expense rows dated within the given calendar month — the
  // same basis Dashboard and Reports already agree on for expenses (per the audit, this
  // is the one figure that was NOT diverging), now available with explicit metadata for
  // any new consumer.
  async getActualMonthlyExpenses(userId: string, month?: string): Promise<FinancialFactDTO> {
    validateMonthFormat(month);
    const targetMonth = month ?? currentMonthString();

    const expenses = await this.expensesService.list(userId, targetMonth);
    const value = expenses.reduce((sum, e) => sum + Number(e.amount), 0);

    return {
      metric: "actualMonthlyExpenses",
      value: value.toFixed(2),
      currency: CURRENCY,
      basis: "ACTUAL",
      asOf: new Date().toISOString(),
      sourceTypes: ["Expense"],
      confidence: "HIGH",
      explanationKey: "expenses.monthlyActual",
    };
  }

  // basis: FORECAST. Unlike Income, Expense has no recurrence-cadence field to normalize
  // (only a boolean isRecurring flag — see the audit's data-model notes), so there is no
  // equivalent to IncomeService.monthlyForecast() to wrap. Instead this uses an honestly
  // disclosed heuristic — the trailing-3-calendar-month average of ACTUAL monthly expense
  // totals — as a reasonable near-term projection. confidence is explicitly MEDIUM (not
  // HIGH) to signal this is a heuristic, not a normalized sum of committed obligations.
  // Any month with zero actual data is excluded from the average rather than counted as
  // a 0, so a brand-new account isn't dragged toward an artificially low forecast.
  async getForecastMonthlyExpenses(userId: string): Promise<FinancialFactDTO> {
    const currentMonth = currentMonthString();
    const monthsToAverage = [1, 2, 3].map((n) => monthsBefore(currentMonth, n));

    const totals = await Promise.all(
      monthsToAverage.map(async (month) => {
        const fact = await this.getActualMonthlyExpenses(userId, month);
        return Number(fact.value);
      }),
    );
    const nonZeroTotals = totals.filter((t) => t > 0);

    const value =
      nonZeroTotals.length > 0 ? nonZeroTotals.reduce((sum, t) => sum + t, 0) / nonZeroTotals.length : 0;

    return {
      metric: "forecastMonthlyExpenses",
      value: value.toFixed(2),
      currency: CURRENCY,
      basis: "FORECAST",
      asOf: new Date().toISOString(),
      sourceTypes: ["Expense"],
      confidence: nonZeroTotals.length >= 2 ? "MEDIUM" : "LOW",
      explanationKey: "expenses.monthlyForecastTrailingAverage",
    };
  }

  // Not itself a FinancialFactDTO (this is consumed internally by DashboardService's
  // health-score calc, which needs the raw numeric pieces, not a formatted fact) — see
  // getEmergencyFundStatusFact() below for the DTO-wrapped, externally-consumable form.
  //
  // #2 fix, relocated here from DashboardService so Dashboard and any future consumer
  // (Coach, AI Search) share exactly one implementation: prefer summing currentAmount
  // across any Goal(s) of type EMERGENCY_FUND; fall back to the legacy
  // Expense-category-literally-named-"Emergency Fund" match only if no such goal exists,
  // so accounts relying on the old behavior don't silently regress to 0.
  //
  // `prefetched` is an optional escape hatch for callers (DashboardService.getSummary())
  // that already queried this month's goals/expenses as part of the same request's
  // Promise.all fan-out — passing them in avoids re-issuing the identical
  // goal.findMany/expense.findMany queries a second time. Standalone callers that don't
  // have this data on hand (Coach, AI Search) simply omit it and it's fetched fresh.
  async getEmergencyFundStatus(
    userId: string,
    monthlyExpenseTotal: number,
    prefetched?: {
      emergencyFundGoals?: { currentAmount: unknown }[];
      monthExpenses?: { amount: unknown; category: { name: string } }[];
    },
  ): Promise<EmergencyFundStatus> {
    const currentMonth = currentMonthString();

    const emergencyFundGoals =
      prefetched?.emergencyFundGoals ??
      (await this.prisma.client.goal.findMany({ where: { userId, type: "EMERGENCY_FUND" } }));
    const monthExpenses =
      prefetched?.monthExpenses ?? (await this.expensesService.list(userId, currentMonth));

    let amount = 0;
    let basis: EmergencyFundStatus["basis"] = "NONE";

    // Preferred, authoritative source: the EmergencyFundEntry reserve ledger. Only used
    // once at least one entry exists, so accounts that still rely on a Goal (or the
    // legacy category) keep working exactly as before until they start using it.
    const ledger = await this.prisma.client.emergencyFundEntry.groupBy({
      by: ["type"],
      where: { userId },
      _sum: { amount: true },
    });

    if (ledger.length > 0) {
      const cash = ledger.reduce<Dec>(
        (acc, row) =>
          acc.plus(emergencyReserveDelta({ type: row.type as EmergencyEntryType, amount: row._sum.amount ?? 0 })),
        ZERO,
      );
      amount = cash.toNumber();
      basis = "LEDGER";
    } else if (emergencyFundGoals.length > 0) {
      amount = emergencyFundGoals.reduce((sum, g) => sum + Number(g.currentAmount), 0);
      basis = "GOAL";
    } else {
      const legacyCategoryExpense = monthExpenses.find((e) => e.category.name === "Emergency Fund");
      if (legacyCategoryExpense) {
        amount = Number(legacyCategoryExpense.amount);
        basis = "CATEGORY_LEGACY";
      }
    }

    // `monthlyExpenseTotal` is ALREADY a monthly figure, so coverage is simply
    // reserve / monthly expenses. The previous `/ 12` here inflated coverage 12x.
    const monthsOfCoverage = monthlyExpenseTotal > 0 && amount > 0 ? amount / monthlyExpenseTotal : 0;

    return { amount, basis, monthsOfCoverage };
  }

  // DTO-wrapped form of getEmergencyFundStatus(), for external/API/AI-Coach consumers
  // that want the standard FinancialFactDTO shape rather than the raw internal object.
  async getEmergencyFundStatusFact(
    userId: string,
    monthlyExpenseTotal: number,
    prefetched?: {
      emergencyFundGoals?: { currentAmount: unknown }[];
      monthExpenses?: { amount: unknown; category: { name: string } }[];
    },
  ): Promise<FinancialFactDTO> {
    const status = await this.getEmergencyFundStatus(userId, monthlyExpenseTotal, prefetched);
    return {
      metric: "emergencyFundMonthsOfCoverage",
      value: status.monthsOfCoverage.toFixed(2),
      currency: CURRENCY,
      // basis is always ACTUAL here: both the GOAL and CATEGORY_LEGACY paths compute
      // monthsOfCoverage from real, currently-held amounts (a goal's current savings or
      // this month's actual expense), never a projection — NONE has no underlying data
      // at all, but "no data" isn't a different basis, just an empty one.
      basis: "ACTUAL",
      asOf: new Date().toISOString(),
      sourceTypes:
        status.basis === "LEDGER"
          ? ["EmergencyFundEntry"]
          : status.basis === "GOAL"
            ? ["Goal"]
            : status.basis === "CATEGORY_LEGACY"
              ? ["Expense"]
              : [],
      confidence:
        status.basis === "LEDGER" || status.basis === "GOAL" ? "HIGH" : status.basis === "CATEGORY_LEGACY" ? "MEDIUM" : "LOW",
      explanationKey:
        status.basis === "LEDGER"
          ? "emergencyFund.fromLedger"
          : status.basis === "GOAL"
          ? "emergencyFund.fromGoal"
          : status.basis === "CATEGORY_LEGACY"
            ? "emergencyFund.fromLegacyCategory"
            : "emergencyFund.none",
    };
  }

  // ---------------------------------------------------------------------------------
  // Authoritative financial core (financial-core upgrade). Everything below is computed
  // with Decimal arithmetic through financial-formulas.ts — the ONLY place the formulas
  // live. Existing methods above are untouched so current callers keep working while
  // Dashboard / Reports / AI are migrated onto these.
  // ---------------------------------------------------------------------------------

  // Legacy SAVINGS-category expenses that have not been migrated into
  // InvestmentCashflow / EmergencyFundEntry. They are real cash that left the account,
  // but they are NOT spending, so they are excluded from "expenses" and reported as a
  // data-health warning instead. A row is "migrated" once a cashflow/entry points at it
  // via sourceExpenseId (the original Expense is preserved, never deleted).
  private async loadUnmigratedSavingsExpenses(userId: string, range?: { gte?: Date; lt?: Date; lte?: Date }) {
    const [rows, cashflowRefs, entryRefs] = await Promise.all([
      this.prisma.client.expense.findMany({
        where: { userId, category: { type: "SAVINGS" }, ...(range ? { spentAt: range } : {}) },
        select: { id: true, amount: true, category: { select: { name: true } } },
      }),
      this.prisma.client.investmentCashflow.findMany({
        where: { userId, sourceExpenseId: { not: null } },
        select: { sourceExpenseId: true },
      }),
      this.prisma.client.emergencyFundEntry.findMany({
        where: { userId, sourceExpenseId: { not: null } },
        select: { sourceExpenseId: true },
      }),
    ]);
    const migrated = new Set<string>();
    for (const r of cashflowRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);
    for (const r of entryRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);
    return rows.filter((r) => !migrated.has(r.id));
  }

  private legacyWarnings(rows: { amount: unknown; category: { name: string } }[]): DataHealthWarning[] {
    const isEmergency = (n: string) => /emergency/i.test(n);
    const emergency = rows.filter((r) => isEmergency(r.category.name));
    const investment = rows.filter((r) => !isEmergency(r.category.name));
    const out: DataHealthWarning[] = [];
    if (investment.length > 0) {
      out.push({
        code: "INVESTMENT_AS_EXPENSE",
        severity: "WARNING",
        message:
          "Some investment/savings entries are still recorded as expenses. They are excluded from expense totals and not yet counted as investment contributions until reviewed and migrated.",
        count: investment.length,
        amount: toMoneyString(sumDecimals(investment.map((r) => r.amount as Prisma.Decimal.Value))),
      });
    }
    if (emergency.length > 0) {
      out.push({
        code: "EMERGENCY_AS_EXPENSE",
        severity: "WARNING",
        message:
          "Some emergency-fund allocations are still recorded as expenses. They are excluded from expense totals and not yet counted in Emergency Cash until reviewed and migrated.",
        count: emergency.length,
        amount: toMoneyString(sumDecimals(emergency.map((r) => r.amount as Prisma.Decimal.Value))),
      });
    }
    return out;
  }

  private foldCashflows(rows: { type: string; _sum: { amount: Prisma.Decimal | null } }[]): CashflowTotals {
    return rows.reduce<CashflowTotals>(
      (acc, r) => addCashflow(acc, r.type as CashflowType, r._sum.amount ?? 0),
      emptyCashflowTotals(),
    );
  }

  // basis: ACTUAL, period: LIFETIME. The one place Available Cash, Emergency Cash, Total
  // Cash, investment value and Net Worth are derived. `openingAvailableCash` lets a
  // caller supply a known starting balance (the schema has no opening-balance field, so
  // by default the cash model is built purely from recorded history).
  async getFinancialPosition(
    userId: string,
    opts: { asOf?: Date; openingAvailableCash?: Prisma.Decimal.Value } = {},
  ): Promise<FinancialPosition> {
    const asOf = opts.asOf ?? new Date();

    const [incomeAgg, expenseAgg, unmigrated, cashflowRows, emergencyRows, investments, propertyAgg, loanAgg] =
      await Promise.all([
        this.prisma.client.income.aggregate({ where: { userId, receivedAt: { lte: asOf } }, _sum: { amount: true } }),
        this.prisma.client.expense.aggregate({
          where: { userId, spentAt: { lte: asOf }, category: { type: { not: "SAVINGS" } } },
          _sum: { amount: true },
        }),
        this.loadUnmigratedSavingsExpenses(userId, { lte: asOf }),
        this.prisma.client.investmentCashflow.groupBy({
          by: ["type"],
          where: { userId, occurredAt: { lte: asOf } },
          _sum: { amount: true },
        }),
        this.prisma.client.emergencyFundEntry.groupBy({
          by: ["type"],
          where: { userId, occurredAt: { lte: asOf } },
          _sum: { amount: true },
        }),
        this.prisma.client.investment.findMany({
          where: { userId },
          select: {
            id: true,
            currentValue: true,
            valuations: { where: { valuedAt: { lte: asOf } }, orderBy: { valuedAt: "desc" }, take: 1 },
          },
        }),
        this.prisma.client.property.aggregate({ where: { userId }, _sum: { currentValue: true } }),
        this.prisma.client.loan.aggregate({ where: { userId }, _sum: { outstandingPrincipal: true } }),
      ]);

    const totals = this.foldCashflows(cashflowRows);
    const emergencyCashAmount = emergencyRows.reduce<Dec>(
      (acc, r) => acc.plus(emergencyReserveDelta({ type: r.type as EmergencyEntryType, amount: r._sum.amount ?? 0 })),
      ZERO,
    );
    const emergencyAvailDelta = emergencyRows.reduce<Dec>(
      (acc, r) =>
        acc.plus(emergencyAvailableCashDelta({ type: r.type as EmergencyEntryType, amount: r._sum.amount ?? 0 })),
      ZERO,
    );

    const income = toDecimal(incomeAgg._sum.amount);
    const expenses = toDecimal(expenseAgg._sum.amount);
    const unclassifiedOutflow = sumDecimals(unmigrated.map((r) => r.amount as Prisma.Decimal.Value));

    const cash = computeCashModel({
      income,
      expenses,
      investmentCashOutflow: investmentCashOutflow(totals),
      investmentCashInflow: investmentCashInflow(totals),
      emergencyAvailableCashDelta: emergencyAvailDelta,
      emergencyCashAmount,
      unclassifiedOutflow,
      otherCashInflow: toDecimal(opts.openingAvailableCash),
    });

    const warnings = this.legacyWarnings(unmigrated);
    const staleCutoff = new Date(asOf.getTime() - STALE_VALUATION_DAYS * 86_400_000);
    let investmentValue = ZERO;
    let missing = 0;
    let stale = 0;
    for (const inv of investments) {
      const latest = inv.valuations[0];
      if (latest) {
        investmentValue = investmentValue.plus(toDecimal(latest.value));
        if (latest.valuedAt < staleCutoff) stale += 1;
      } else {
        // Legacy fallback: Investment.currentValue is still honored when no dated
        // valuation exists yet, so existing portfolios do not drop to zero.
        investmentValue = investmentValue.plus(toDecimal(inv.currentValue));
        missing += 1;
      }
    }
    if (missing > 0) {
      warnings.push({
        code: "MISSING_INVESTMENT_VALUATION",
        severity: "INFO",
        message: "Some investments have no dated valuation; their legacy current value is being used.",
        count: missing,
      });
    }
    if (stale > 0) {
      warnings.push({
        code: "STALE_INVESTMENT_VALUATION",
        severity: "WARNING",
        message: `Some investment valuations are older than ${STALE_VALUATION_DAYS} days, so portfolio value may be out of date.`,
        count: stale,
      });
    }

    const property = toDecimal(propertyAgg._sum.currentValue);
    const loans = toDecimal(loanAgg._sum.outstandingPrincipal);
    const nw = computeNetWorth({
      availableCash: cash.availableCash,
      emergencyCash: cash.emergencyCash,
      investments: investmentValue,
      property,
      business: ZERO, // Business has no valuation field in the schema; not guessed.
      otherAssets: ZERO,
      loans,
      creditCardOutstanding: ZERO, // credit-card balances are modeled as Loan(type=CREDIT_CARD)
      otherLiabilities: ZERO,
    });

    return {
      basis: "ACTUAL",
      period: "LIFETIME",
      asOfDate: asOf.toISOString(),
      currency: CURRENCY,
      cash: {
        available: toMoneyString(cash.availableCash),
        emergency: toMoneyString(cash.emergencyCash),
        total: toMoneyString(cash.totalCash),
      },
      income: toMoneyString(income),
      expenses: toMoneyString(expenses),
      investmentContributions: toMoneyString(totals.contributions),
      investmentWithdrawals: toMoneyString(totals.withdrawals),
      investmentValue: toMoneyString(investmentValue),
      property: toMoneyString(property),
      loans: toMoneyString(loans),
      totalAssets: toMoneyString(nw.totalAssets),
      totalLiabilities: toMoneyString(nw.totalLiabilities),
      netWorth: toMoneyString(nw.netWorth),
      dataHealth: warnings,
    };
  }

  // basis: ACTUAL, period: MONTHLY. Answers "how much did I invest this month?",
  // savings rate, investment rate and expense rate from the same numbers. Rates are
  // returned as ratios (0.25 = 25%) — never pre-multiplied by 100.
  async getMonthlyCashFlow(userId: string, month?: string): Promise<MonthlyCashFlow> {
    validateMonthFormat(month);
    const targetMonth = month ?? currentMonthString();
    const { start, end } = monthRange(targetMonth);

    const [incomeAgg, expenseAgg, unmigrated, cashflowRows, emergencyRows] = await Promise.all([
      this.prisma.client.income.aggregate({
        where: { userId, receivedAt: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
      this.prisma.client.expense.aggregate({
        where: { userId, spentAt: { gte: start, lt: end }, category: { type: { not: "SAVINGS" } } },
        _sum: { amount: true },
      }),
      this.loadUnmigratedSavingsExpenses(userId, { gte: start, lt: end }),
      this.prisma.client.investmentCashflow.groupBy({
        by: ["type"],
        where: { userId, occurredAt: { gte: start, lt: end } },
        _sum: { amount: true },
      }),
      this.prisma.client.emergencyFundEntry.groupBy({
        by: ["type"],
        where: { userId, occurredAt: { gte: start, lt: end }, type: "ALLOCATE" },
        _sum: { amount: true },
      }),
    ]);

    const income = toDecimal(incomeAgg._sum.amount);
    const expenses = toDecimal(expenseAgg._sum.amount);
    const totals = this.foldCashflows(cashflowRows);
    const contributions = totals.contributions;
    const allocations = sumDecimals(emergencyRows.map((r) => r._sum.amount));

    const ratio = (d: Dec | null) => (d === null ? null : d.toString());
    return {
      basis: "ACTUAL",
      period: "MONTHLY",
      asOfDate: new Date().toISOString(),
      currency: CURRENCY,
      month: targetMonth,
      income: toMoneyString(income),
      expenses: toMoneyString(expenses),
      investmentContributions: toMoneyString(contributions),
      emergencyAllocations: toMoneyString(allocations),
      netCashFlow: toMoneyString(
        income
          .minus(expenses)
          .minus(contributions)
          .minus(allocations)
          .plus(investmentCashInflow(totals)),
      ),
      savingsRate: ratio(savingsRate(income, expenses)),
      investmentRate: ratio(investmentRate(contributions, income)),
      expenseRate: ratio(expenseRate(expenses, income)),
      dataHealth: this.legacyWarnings(unmigrated),
    };
  }

  // basis: ACTUAL. Emergency Cash / AVERAGE MONTHLY ESSENTIAL expenses. Essential means
  // category type NEED, averaged over up to the last 3 COMPLETE calendar months that
  // actually have data (a brand-new account is not dragged toward zero). Not divided by
  // 12: the average is already monthly.
  async getEmergencyCoverage(userId: string): Promise<EmergencyCoverage> {
    const currentMonth = currentMonthString();
    const windowStart = monthRange(monthsBefore(currentMonth, 3)).start;
    const windowEnd = monthRange(currentMonth).start; // exclusive: current month is incomplete

    const [ledger, needs] = await Promise.all([
      this.prisma.client.emergencyFundEntry.groupBy({ by: ["type"], where: { userId }, _sum: { amount: true } }),
      this.prisma.client.expense.findMany({
        where: { userId, spentAt: { gte: windowStart, lt: windowEnd }, category: { type: "NEED" } },
        select: { amount: true, spentAt: true },
      }),
    ]);

    const cash = ledger.reduce<Dec>(
      (acc, r) => acc.plus(emergencyReserveDelta({ type: r.type as EmergencyEntryType, amount: r._sum.amount ?? 0 })),
      ZERO,
    );

    const byMonth = new Map<string, Dec>();
    for (const e of needs) {
      const key = `${e.spentAt.getUTCFullYear()}-${String(e.spentAt.getUTCMonth() + 1).padStart(2, "0")}`;
      byMonth.set(key, (byMonth.get(key) ?? ZERO).plus(toDecimal(e.amount)));
    }
    const monthsOfData = byMonth.size;
    const avg = monthsOfData === 0 ? ZERO : sumDecimals([...byMonth.values()]).div(monthsOfData);
    const months = emergencyCoverageMonths(cash, avg);

    return {
      basis: "ACTUAL",
      period: "MONTHLY",
      asOfDate: new Date().toISOString(),
      currency: CURRENCY,
      emergencyCash: toMoneyString(cash),
      avgMonthlyEssentialExpenses: toMoneyString(avg),
      coverageMonths: months === null ? null : months.toDecimalPlaces(2).toFixed(2),
      monthsOfData,
    };
  }

  // Per-investment derived metrics (net contributions, cost basis, unrealized/realized
  // gain, total return) — profit is always derived, never user-entered.
  async getInvestmentSummary(userId: string, investmentId: string) {
    const inv = await this.prisma.client.investment.findFirst({
      where: { id: investmentId, userId }, // ownership enforced in the query itself
      select: { id: true, name: true, type: true, currentValue: true },
    });
    if (!inv) return null;

    const [cashflowRows, latest, realized] = await Promise.all([
      this.prisma.client.investmentCashflow.groupBy({
        by: ["type"],
        where: { userId, investmentId },
        _sum: { amount: true },
      }),
      this.prisma.client.investmentValuation.findFirst({
        where: { userId, investmentId },
        orderBy: { valuedAt: "desc" },
      }),
      this.prisma.client.realizedGainEvent.aggregate({
        where: { userId, investmentId },
        _sum: { costBasisPortion: true, gainAmount: true },
      }),
    ]);

    const m = deriveInvestmentMetrics({
      totals: this.foldCashflows(cashflowRows),
      currentValue: toDecimal(latest?.value ?? inv.currentValue),
      realizedCostBasisSold: toDecimal(realized._sum.costBasisPortion),
      realizedGain: toDecimal(realized._sum.gainAmount),
    });

    return {
      investmentId: inv.id,
      name: inv.name,
      type: inv.type,
      basis: "ACTUAL" as const,
      period: "LIFETIME" as const,
      asOfDate: (latest?.valuedAt ?? new Date()).toISOString(),
      valuationSource: latest ? ("VALUATION" as const) : ("LEGACY_CURRENT_VALUE" as const),
      grossContributions: toMoneyString(m.grossContributions),
      employerContributions: toMoneyString(m.employerContributions),
      withdrawals: toMoneyString(m.withdrawals),
      netContributions: toMoneyString(m.netContributions),
      costBasis: toMoneyString(m.costBasis),
      currentValue: toMoneyString(m.currentValue),
      unrealizedGain: toMoneyString(m.unrealizedGain),
      realizedGain: toMoneyString(m.realizedGain),
      dividends: toMoneyString(m.dividends),
      fees: toMoneyString(m.fees),
      totalReturn: toMoneyString(m.totalReturn),
      returnRatio: m.returnPercentage === null ? null : m.returnPercentage.toString(),
    };
  }
}
