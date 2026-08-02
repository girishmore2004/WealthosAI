import { BadRequestException, Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { BusinessService } from "../business/business.service";
import { currentFinancialYear, financialYearRange } from "../common/utils/financial-year.util";
import { groupExpensesByCategory } from "../common/utils/report-aggregation.util";
import { csvCell, csvRow } from "../common/utils/csv.util";
import { MonthlyReportDTO, YearlyReportDTO } from "@wealthos/types";

const MONTH_FORMAT = /^\d{4}-(0[1-9]|1[0-2])$/;
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
  ) {}

  private monthRange(month: string) {
    const start = new Date(`${month}-01T00:00:00.000Z`);
    const end = new Date(start);
    // UTC-safe on purpose: `start` is parsed as a UTC instant, so the boundary must be
    // advanced in UTC too. The previous version used the local-time setMonth()/getMonth(),
    // which is correct only when the server's TZ happens to be UTC — under a negative
    // UTC-offset TZ (e.g. US Pacific), the local calendar date for a UTC midnight
    // timestamp can roll back a day, silently shifting the whole month window.
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start, end };
  }

  // "YYYY-MM" only. An unvalidated month string (typo, wrong separator, out-of-range
  // month like "2026-13") used to fall straight into `new Date(...)`, silently producing
  // an Invalid Date and a report full of zeros instead of a clear error to the caller.
  private validateMonth(month?: string): void {
    if (month !== undefined && !MONTH_FORMAT.test(month)) {
      throw new BadRequestException('"month" must be in YYYY-MM format, e.g. 2026-07');
    }
  }

  // "YYYY-YY" (e.g. "2026-27"). Same rationale as validateMonth(): an invalid string used
  // to silently pass through financialYearRange()'s Number() parsing, producing an
  // Invalid Date range and a report that looks empty rather than erroring clearly.
  private validateFinancialYear(financialYear?: string): void {
    if (financialYear !== undefined && !FINANCIAL_YEAR_FORMAT.test(financialYear)) {
      throw new BadRequestException('"financialYear" must be in YYYY-YY format, e.g. 2026-27');
    }
  }

  async monthlyReport(userId: string, month?: string): Promise<MonthlyReportDTO> {
    this.validateMonth(month);
    const targetMonth = month ?? new Date().toISOString().slice(0, 7);
    const { start, end } = this.monthRange(targetMonth);

    const [incomes, expenses] = await Promise.all([
      this.incomeService.list(userId),
      this.expensesService.list(userId, targetMonth),
    ]);

    const monthIncome = incomes
      .filter((i) => i.receivedAt >= start && i.receivedAt < end)
      .reduce((sum, i) => sum + Number(i.amount), 0);

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

    const totalExpenses = allExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const expensesByCategory = groupExpensesByCategory(allExpenses, totalExpenses);

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
