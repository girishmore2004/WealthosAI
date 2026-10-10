import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { BusinessService } from "../business/business.service";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { currentFinancialYear, financialYearRange } from "../common/utils/financial-year.util";
import { monthRange, validateMonthFormat, currentMonthString } from "../common/utils/financial-period.util";
import { groupExpensesByCategory } from "../common/utils/report-aggregation.util";
import { csvCell, csvRow } from "../common/utils/csv.util";
import type {
  MonthlyReportDTO,
  MonthlyReportDetailDTO,
  ReportCategoryRowDTO,
  YearlyMonthRowDTO,
  YearlyMonthsReportDTO,
  YearlyReportDTO,
} from "@wealthos/types";
import { Prisma } from "@wealthos/db";
import { savingsRate as savingsRateRatio, sumDecimals, toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import { monthName, monthlyNarrative, yearlyNarrative } from "../common/financial-facts/financial-narrative";

const FINANCIAL_YEAR_FORMAT = /^\d{4}-\d{2}$/;

// Report computation lives here, not in page components, so the numbers are guaranteed
// consistent with the dashboard/tax/other modules that pull from the same services.
@Injectable()
export class ReportsService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
    private expensesService: ExpensesService,
    private investmentsService: InvestmentsService,
    private loansService: LoansService,
    private businessService: BusinessService,
    private financialFactsService: FinancialFactsService,
  ) {}

  // "YYYY-YY" (e.g. "2026-27"). Same rationale as validateMonthFormat(): an invalid
  // string used to silently pass through financialYearRange()'s Number() parsing,
  // producing an Invalid Date range and a report that looks empty rather than erroring
  // clearly.
  private validateFinancialYear(financialYear?: string): void {
    if (financialYear !== undefined && !FINANCIAL_YEAR_FORMAT.test(financialYear)) {
      throw new BadRequestException('"financialYear" must be in YYYY-YY format, e.g. 2026-27');
    }
  }

  // #1 fix (audit's highest-leverage finding): monthly income here now flows through
  // FinancialFactsService.getActualMonthlyIncome(), the same canonical method Dashboard
  // can call for the "actual" basis — instead of an inline filter+reduce that lived only
  // in this file. The computed number is UNCHANGED (it's the identical date-range-filtered
  // sum as before); what changes is that this is no longer an independent reimplementation
  // that could silently drift from Dashboard's own income calculation.
  async monthlyReport(userId: string, month?: string): Promise<MonthlyReportDTO> {
    validateMonthFormat(month);
    const targetMonth = month ?? currentMonthString();

    const [incomeFact, monthExpenses] = await Promise.all([
      this.financialFactsService.getActualMonthlyIncome(userId, targetMonth),
      this.expensesService.list(userId, targetMonth),
    ]);

    const monthIncome = Number(incomeFact.value);
    // Expenses are actual spending: legacy SAVINGS-category rows (SIP / emergency-fund
    // entries) are excluded so a SIP is never reported as spending.
    const expenses = monthExpenses.filter((e) => e.category?.type !== "SAVINGS");
    const totalExpenses = expenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const expensesByCategory = groupExpensesByCategory(expenses, totalExpenses);

    const netCashflow = monthIncome - totalExpenses;

    return {
      month: targetMonth,
      income: monthIncome.toFixed(2),
      expenses: totalExpenses.toFixed(2),
      netCashflow: netCashflow.toFixed(2),
      savingsRate: monthIncome > 0 ? Number(((netCashflow / monthIncome) * 100).toFixed(1)) : 0,
      expensesByCategory,
      // NEW (audit item #1): explicit basis labels so a caller never has to guess
      // whether "income" here means the same thing Dashboard's monthlyIncome means.
      // Reports has always used ACTUAL — this makes that fact machine-readable instead
      // of only living in a code comment.
      incomeBasis: "ACTUAL",
      expensesBasis: "ACTUAL",
    };
  }

  async yearlyReport(userId: string, financialYear?: string): Promise<YearlyReportDTO> {
    this.validateFinancialYear(financialYear);
    const now = new Date();
    const fy = financialYear ?? currentFinancialYear(now);
    const { fyStart, fyEnd } = financialYearRange(fy);

    const [incomes, allExpenses, investmentSummary, debtSummary, businessProfit] = await Promise.all([
      this.incomeService.list(userId),
      this.prisma.client.expense.findMany({
        where: { userId, spentAt: { gte: fyStart, lte: fyEnd } },
        include: { category: true },
      }),
      this.investmentsService.summary(userId),
      this.loansService.debtSummary(userId),
      this.businessService.annualProfitForUser(userId, fyStart, fyEnd),
    ]);

    const totalIncome = incomes
      .filter((i) => i.receivedAt >= fyStart && i.receivedAt <= fyEnd)
      .reduce((sum, i) => sum + Number(i.amount), 0);

    const spendingExpenses = allExpenses.filter((e) => e.category.type !== "SAVINGS");
    const totalExpenses = spendingExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const expensesByCategory = groupExpensesByCategory(spendingExpenses, totalExpenses);

    return {
      financialYear: fy,
      totalIncome: totalIncome.toFixed(2),
      totalExpenses: totalExpenses.toFixed(2),
      netSavings: (totalIncome - totalExpenses).toFixed(2),
      investmentsCurrentValue: investmentSummary.totalCurrentValue,
      totalDebtOutstanding: debtSummary.totalOutstanding,
      businessProfit: businessProfit !== null ? businessProfit.toFixed(2) : null,
      expensesByCategory,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Batch 8: the detailed monthly and January-to-December reports. Every figure comes from
  // FinancialFactsService.getMoneyFlow() (cash-flow kinds) or ExpensesService.analytics()
  // (spending), i.e. the very same code the dashboard and the AI Coach use, so the three can never
  // disagree. The narrative is plain text assembled from those numbers (financial-narrative.ts).
  // ---------------------------------------------------------------------------------------------
  async monthlyDetail(userId: string, month?: string, now: Date = new Date()): Promise<MonthlyReportDetailDTO> {
    validateMonthFormat(month);
    const target = month ?? currentMonthString(now);
    const { start, end } = monthRange(target);
    const lastDay = new Date(end.getTime() - 86_400_000);
    const todayIso = clampDay(now, start, lastDay);

    const [flow, analytics, split, largest] = await Promise.all([
      this.financialFactsService.getMoneyFlow(userId, target),
      this.expensesService.analytics(userId, { from: isoDate(start), to: isoDate(lastDay), today: todayIso }),
      this.expensesService.recurringSplit(userId, start, end),
      this.expensesService.largestTransactions(userId, start, end, 5),
    ]);

    const categories = categoryRows(analytics.categories);
    const expenseRate = ratioToPercent(flow.expenseRate);
    const investmentRate = ratioToPercent(flow.investmentRate);
    const savingsRate = ratioToPercent(flow.savingsRate);
    const netWorthChange = toDecimal(flow.income).minus(toDecimal(flow.outflows.expenses)).minus(toDecimal(flow.outflows.otherOutflow));
    const previousLabel = monthName(analytics.comparison.from.slice(0, 7));

    return {
      basis: "ACTUAL",
      month: target,
      currency: flow.currency,
      moneyFlow: flow as MonthlyReportDetailDTO["moneyFlow"],
      income: flow.income,
      expenses: flow.outflows.expenses,
      investments: flow.outflows.investments,
      emergencyFund: flow.outflows.emergencyFund,
      receivablesGiven: flow.outflows.receivablesGiven,
      receivableRepayments: flow.inflows.receivableRepayments,
      otherOutflow: flow.outflows.otherOutflow,
      internalTransfers: flow.internalTransfers,
      netCashFlow: flow.netCashFlow,
      savingsRate,
      investmentRate,
      expenseRate,
      netWorthChange: {
        basis: "ESTIMATED",
        amount: toMoneyString(netWorthChange),
        note: "Income minus expenses and other outflows. Money you invest, reserve or lend stays an asset, so it does not reduce net worth. Market-value changes and loan principal are not included.",
      },
      categories,
      topCategories: categories.slice(0, 5),
      dailySpending: analytics.daily,
      averagePerDay: analytics.totals.averagePerDay,
      highestDay: analytics.highestDay,
      recurringVsOneTime: split,
      largestTransactions: largest,
      comparison: analytics.comparison,
      narrative: monthlyNarrative({
        month: target,
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
        topCategory: categories[0]
          ? { name: categories[0].category, amount: categories[0].amount, percentOfTotal: categories[0].percentOfTotal }
          : null,
        comparison: { label: previousLabel, changePercent: analytics.comparison.changePercent },
      }),
      dataHealth: flow.dataHealth as MonthlyReportDetailDTO["dataHealth"],
    };
  }

  // Calendar year, January to December: one row per month, totals, category report and a trend.
  async yearlyMonths(userId: string, year?: string, now: Date = new Date()): Promise<YearlyMonthsReportDTO> {
    if (year !== undefined && !/^\d{4}$/.test(year)) {
      throw new BadRequestException('"year" must be a 4-digit year, e.g. 2026');
    }
    const y = year ? Number(year) : now.getUTCFullYear();
    if (y < 2000 || y > 2100) throw new BadRequestException('"year" must be between 2000 and 2100');

    const keys = Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`);
    const yearStart = new Date(Date.UTC(y, 0, 1));
    const yearEnd = new Date(Date.UTC(y, 11, 31));
    const flows = await Promise.all(
      keys.map((k) => (monthRange(k).start.getTime() > now.getTime() ? Promise.resolve(null) : this.financialFactsService.getMoneyFlow(userId, k))),
    );
    const analytics = await this.expensesService.analytics(userId, {
      from: isoDate(yearStart),
      to: isoDate(yearEnd),
      today: clampDay(now, yearStart, yearEnd),
    });

    const zero = "0.00";
    const months: YearlyMonthRowDTO[] = keys.map((k, i) => {
      const f = flows[i];
      return {
        month: k,
        income: f?.income ?? zero,
        expenses: f?.outflows.expenses ?? zero,
        investments: f?.outflows.investments ?? zero,
        emergencyFund: f?.outflows.emergencyFund ?? zero,
        receivablesGiven: f?.outflows.receivablesGiven ?? zero,
        otherOutflow: f?.outflows.otherOutflow ?? zero,
        netCashFlow: f?.netCashFlow ?? zero,
        savingsRate: f ? ratioToPercent(f.savingsRate) : null,
      };
    });

    const sum = (pick: (r: YearlyMonthRowDTO) => string) => sumDecimals(months.map(pick));
    const income = sum((r) => r.income);
    const expenses = sum((r) => r.expenses);
    const totalsSavings = savingsRateRatio(income, expenses);
    const withExpenses = months.filter((r) => toDecimal(r.expenses).greaterThan(0));
    const highest = withExpenses.reduce<YearlyMonthRowDTO | null>((a, r) => (!a || toDecimal(r.expenses).greaterThan(a.expenses) ? r : a), null);
    const lowest = withExpenses.reduce<YearlyMonthRowDTO | null>((a, r) => (!a || toDecimal(r.expenses).lessThan(a.expenses) ? r : a), null);
    const monthsWithData = months.filter((r) =>
      [r.income, r.expenses, r.investments, r.emergencyFund, r.receivablesGiven, r.otherOutflow].some((v) => !toDecimal(v).isZero()),
    ).length;
    const categories = categoryRows(analytics.categories);
    const totals = {
      income: toMoneyString(income),
      expenses: toMoneyString(expenses),
      investments: toMoneyString(sum((r) => r.investments)),
      emergencyFund: toMoneyString(sum((r) => r.emergencyFund)),
      receivablesGiven: toMoneyString(sum((r) => r.receivablesGiven)),
      otherOutflow: toMoneyString(sum((r) => r.otherOutflow)),
      netCashFlow: toMoneyString(sum((r) => r.netCashFlow)),
      savingsRate: totalsSavings === null ? null : Number(totalsSavings.times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()),
    };

    return {
      basis: "ACTUAL",
      year: y,
      currency: "INR",
      months,
      totals,
      categories,
      comparison: analytics.comparison,
      highestExpenseMonth: highest ? { month: highest.month, total: highest.expenses } : null,
      lowestExpenseMonth: lowest ? { month: lowest.month, total: lowest.expenses } : null,
      narrative: yearlyNarrative({
        year: y,
        income: totals.income,
        expenses: totals.expenses,
        investments: totals.investments,
        netCashFlow: totals.netCashFlow,
        savingsRate: totals.savingsRate,
        highestExpenseMonth: highest ? { month: highest.month, total: highest.expenses } : null,
        lowestExpenseMonth: lowest ? { month: lowest.month, total: lowest.expenses } : null,
        monthsWithData,
        comparison: { changePercent: analytics.comparison.changePercent },
        topCategory: categories[0] ? { name: categories[0].category, amount: categories[0].amount } : null,
      }),
    };
  }

  async monthlyReportCsv(userId: string, month?: string): Promise<string> {
    const report = await this.monthlyReport(userId, month);
    const generatedAt = new Date().toISOString();

    const lines = [
      csvRow([csvCell("Metric"), csvCell("Value")]),
      csvRow([csvCell("Month"), csvCell(report.month)]),
      csvRow([csvCell("Income"), csvCell(report.income)]),
      csvRow([csvCell("Expenses"), csvCell(report.expenses)]),
      csvRow([csvCell("Net Cashflow"), csvCell(report.netCashflow)]),
      csvRow([csvCell("Savings Rate (%)"), csvCell(report.savingsRate)]),
      csvRow([csvCell("Generated At"), csvCell(generatedAt)]),
      "",
      csvRow([csvCell("Category"), csvCell("Amount"), csvCell("Percent of Total")]),
      ...report.expensesByCategory.map((row) =>
        csvRow([
          csvCell(row.category, { neutralizeFormulas: true }),
          csvCell(row.amount),
          csvCell(row.percentOfTotal),
        ]),
      ),
    ];
    return lines.join("\n");
  }

  // Previously the only export available was monthly — yearly data could be viewed
  // on-screen but never downloaded (audit gap: "Only a monthly CSV export exists...
  // not yearly"). Mirrors monthlyReportCsv()'s metric/value + category-breakdown block
  // shape, extended with the yearly-only metrics (investments, debt, business profit)
  // that monthlyReport() doesn't compute.
  async yearlyReportCsv(userId: string, financialYear?: string): Promise<string> {
    const report = await this.yearlyReport(userId, financialYear);
    const generatedAt = new Date().toISOString();

    const lines = [
      csvRow([csvCell("Metric"), csvCell("Value")]),
      csvRow([csvCell("Financial Year"), csvCell(report.financialYear)]),
      csvRow([csvCell("Total Income"), csvCell(report.totalIncome)]),
      csvRow([csvCell("Total Expenses"), csvCell(report.totalExpenses)]),
      csvRow([csvCell("Net Savings"), csvCell(report.netSavings)]),
      csvRow([csvCell("Investments Current Value"), csvCell(report.investmentsCurrentValue)]),
      csvRow([csvCell("Total Debt Outstanding"), csvCell(report.totalDebtOutstanding)]),
      csvRow([csvCell("Business Profit"), csvCell(report.businessProfit ?? "N/A")]),
      csvRow([csvCell("Generated At"), csvCell(generatedAt)]),
      "",
      csvRow([csvCell("Category"), csvCell("Amount"), csvCell("Percent of Total")]),
      ...report.expensesByCategory.map((row) =>
        csvRow([
          csvCell(row.category, { neutralizeFormulas: true }),
          csvCell(row.amount),
          csvCell(row.percentOfTotal),
        ]),
      ),
    ];
    return lines.join("\n");
  }
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

// "Today" for an analytics window: the real today, held inside [first, last] so a past month counts
// all its days and a future one counts none.
function clampDay(now: Date, first: Date, last: Date): string {
  const t = now.getTime();
  return isoDate(new Date(Math.min(Math.max(t, first.getTime()), last.getTime())));
}

// "0.2370" -> 23.7 (percent, 1 dp). null stays null: no income means no rate, never 0.
function ratioToPercent(ratio: string | null): number | null {
  if (ratio === null) return null;
  return Number(new Prisma.Decimal(ratio).times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString());
}

function categoryRows(
  rows: Array<{ categoryId: string; name: string; type: string; total: string; sharePercent: number | null; previousTotal: string; changePercent: number | null }>,
): ReportCategoryRowDTO[] {
  return [...rows]
    .sort((a, b) => toDecimal(b.total).comparedTo(toDecimal(a.total)))
    .map((r) => ({
      categoryId: r.categoryId,
      category: r.name,
      type: r.type,
      amount: r.total,
      percentOfTotal: r.sharePercent,
      previousAmount: r.previousTotal,
      changePercent: r.changePercent,
    }));
}
