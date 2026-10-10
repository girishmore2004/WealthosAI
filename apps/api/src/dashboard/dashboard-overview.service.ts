import { Injectable } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { DashboardOverviewDTO } from "@wealthos/types";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import { monthlyNarrative, monthName } from "../common/financial-facts/financial-narrative";
import { currentMonthString, monthRange } from "../common/utils/financial-period.util";
import { ExpensesService } from "../expenses/expenses.service";
import { EmergencyFundService } from "../financial-core/emergency-fund/emergency-fund.service";
import { InvestmentAnalyticsService } from "../investments/investment-analytics.service";
import { ReceivablesService } from "../receivables/receivables.service";

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// "0.2370" -> 23.7 (percent). null stays null: no recorded income means no rate, never 0 and never
// floored - a month that spent more than it earned honestly shows a negative savings rate.
const ratioToPercent = (ratio: string | null): number | null =>
  ratio === null ? null : Number(new Prisma.Decimal(ratio).times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString());

/**
 * The dashboard's "where did my money go" overview. It owns no arithmetic of its own: cash-flow kinds
 * come from FinancialFactsService.getMoneyFlow(), spending from ExpensesService, the reserve from
 * EmergencyFundService, receivables from ReceivablesService and investments from the investment
 * ledger - the same sources the Money pages, the reports and the AI Coach read. Everything is ACTUAL;
 * a forecast is never mixed in (the legacy summary's forecast-income savings rate is untouched).
 */
@Injectable()
export class DashboardOverviewService {
  constructor(
    private facts: FinancialFactsService,
    private expenses: ExpensesService,
    private emergency: EmergencyFundService,
    private receivables: ReceivablesService,
    private investments: InvestmentAnalyticsService,
  ) {}

  async overview(userId: string, now: Date = new Date()): Promise<DashboardOverviewDTO> {
    const month = currentMonthString(now);
    const { start, end } = monthRange(month);
    const lastDay = new Date(end.getTime() - 86_400_000);
    const todayIso = isoDate(now);

    const [flow, position, analytics, totals, investmentAnalytics, emergency, receivables] = await Promise.all([
      this.facts.getMoneyFlow(userId, month),
      this.facts.getFinancialPosition(userId),
      this.expenses.analytics(userId, { from: isoDate(start), to: isoDate(lastDay), today: todayIso }),
      this.expenses.periodTotals(userId, todayIso),
      this.investments.analytics(userId, 1, now),
      this.emergency.overview(userId, now),
      this.receivables.summary(userId),
    ]);

    const byType = (type: string) =>
      analytics.categories.filter((c) => c.type === type).reduce((sum, c) => sum.plus(toDecimal(c.total)), new Prisma.Decimal(0));
    const top = [...analytics.categories].sort((a, b) => toDecimal(b.total).comparedTo(toDecimal(a.total)))[0];
    const savingsRate = ratioToPercent(flow.savingsRate);
    const investmentRate = ratioToPercent(flow.investmentRate);
    const expenseRate = ratioToPercent(flow.expenseRate);

    return {
      basis: "ACTUAL",
      asOfDate: flow.asOfDate,
      month,
      currency: flow.currency,
      moneyFlow: flow as DashboardOverviewDTO["moneyFlow"],
      savingsRate,
      investmentRate,
      expenseRate,
      expenses: {
        today: totals.today,
        month: totals.month,
        year: totals.year,
        averagePerDay: analytics.totals.averagePerDay,
        essential: toMoneyString(byType("NEED")),
        discretionary: toMoneyString(byType("WANT")),
        topCategory: top && toDecimal(top.total).greaterThan(0) ? { name: top.name, total: top.total, sharePercent: top.sharePercent } : null,
        largest: analytics.totals.largest,
        highestDay: analytics.highestDay,
        comparison: analytics.comparison,
      },
      investments: {
        totalValue: position.investmentValue,
        contributedThisMonth: flow.outflows.investments,
        contributedThisYear: investmentAnalytics.overview.actualContributionsThisYear,
        plannedMonthlyContribution: investmentAnalytics.overview.plannedMonthlyContribution,
        activeSchedules: investmentAnalytics.overview.activeSchedules,
        holdings: investmentAnalytics.overview.holdings,
      },
      emergencyFund: {
        balance: emergency.balance,
        targetAmount: emergency.target.amount,
        progressPercent: emergency.progress.percent,
        coverageMonths: emergency.coverage.months,
        contributedThisMonth: emergency.totals.contributedThisMonth,
      },
      receivables: {
        outstanding: receivables.totalOutstanding,
        activeCount: receivables.activeCount,
        dueSoon: receivables.dueSoon,
        overdue: receivables.overdue,
      },
      wealth: {
        netWorth: position.netWorth,
        availableCash: position.cash.available,
        emergencyCash: position.cash.emergency,
        investments: position.investmentValue,
        receivables: position.receivables.outstanding,
        property: position.property,
        liabilities: position.totalLiabilities,
      },
      narrative: monthlyNarrative({
        month,
        income: flow.income,
        expenses: flow.outflows.expenses,
        investments: flow.outflows.investments,
        emergencyFund: flow.outflows.emergencyFund,
        receivablesGiven: flow.outflows.receivablesGiven,
        receivableRepayments: flow.inflows.receivableRepayments,
        otherOutflow: flow.outflows.otherOutflow,
        internalTransfers: flow.internalTransfers,
        netCashFlow: flow.netCashFlow,
        expenseRate,
        investmentRate,
        savingsRate,
        topCategory: top ? { name: top.name, amount: top.total, percentOfTotal: top.sharePercent } : null,
        comparison: { label: monthName(analytics.comparison.from.slice(0, 7)), changePercent: analytics.comparison.changePercent },
      }),
      dataHealth: flow.dataHealth as DashboardOverviewDTO["dataHealth"],
    };
  }
}
