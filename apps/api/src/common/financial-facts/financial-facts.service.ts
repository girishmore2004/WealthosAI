import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { IncomeService } from "../../income/income.service";
import { ExpensesService } from "../../expenses/expenses.service";
import { monthRange, currentMonthString, monthsBefore, validateMonthFormat } from "../utils/financial-period.util";
import { FinancialFactDTO } from "@wealthos/types";

const CURRENCY = "INR";

export interface EmergencyFundStatus {
  amount: number;
  basis: "GOAL" | "CATEGORY_LEGACY" | "NONE";
  monthsOfCoverage: number;
}

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

    if (emergencyFundGoals.length > 0) {
      amount = emergencyFundGoals.reduce((sum, g) => sum + Number(g.currentAmount), 0);
      basis = "GOAL";
    } else {
      const legacyCategoryExpense = monthExpenses.find((e) => e.category.name === "Emergency Fund");
      if (legacyCategoryExpense) {
        amount = Number(legacyCategoryExpense.amount);
        basis = "CATEGORY_LEGACY";
      }
    }

    const monthsOfCoverage =
      monthlyExpenseTotal > 0 && amount > 0 ? amount / (monthlyExpenseTotal / 12) : 0;

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
      sourceTypes: status.basis === "GOAL" ? ["Goal"] : status.basis === "CATEGORY_LEGACY" ? ["Expense"] : [],
      confidence: status.basis === "GOAL" ? "HIGH" : status.basis === "CATEGORY_LEGACY" ? "MEDIUM" : "LOW",
      explanationKey:
        status.basis === "GOAL"
          ? "emergencyFund.fromGoal"
          : status.basis === "CATEGORY_LEGACY"
            ? "emergencyFund.fromLegacyCategory"
            : "emergencyFund.none",
    };
  }
}
