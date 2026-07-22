import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { BusinessService } from "../business/business.service";
import { currentFinancialYear, financialYearRange } from "../common/utils/financial-year.util";
import { MonthlyReportDTO, YearlyReportDTO } from "@wealthos/types";

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
    end.setMonth(end.getMonth() + 1);
    return { start, end };
  }

  async monthlyReport(userId: string, month?: string): Promise<MonthlyReportDTO> {
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

    const byCategory = new Map<string, number>();
    for (const e of expenses) {
      byCategory.set(e.category.name, (byCategory.get(e.category.name) ?? 0) + Number(e.amount));
    }

    const expensesByCategory = Array.from(byCategory.entries())
      .map(([category, amount]) => ({
        category,
        amount: amount.toFixed(2),
        percentOfTotal: totalExpenses > 0 ? Number(((amount / totalExpenses) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));

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

    const byCategory = new Map<string, number>();
    for (const e of allExpenses) {
      byCategory.set(e.category.name, (byCategory.get(e.category.name) ?? 0) + Number(e.amount));
    }
    const expensesByCategory = Array.from(byCategory.entries())
      .map(([category, amount]) => ({
        category,
        amount: amount.toFixed(2),
        percentOfTotal: totalExpenses > 0 ? Number(((amount / totalExpenses) * 100).toFixed(1)) : 0,
      }))
      .sort((a, b) => Number(b.amount) - Number(a.amount));

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
    const lines = [
      "Metric,Value",
      `Month,${report.month}`,
      `Income,${report.income}`,
      `Expenses,${report.expenses}`,
      `Net Cashflow,${report.netCashflow}`,
      `Savings Rate (%),${report.savingsRate}`,
      "",
      "Category,Amount,Percent of Total",
      ...report.expensesByCategory.map((row) => `${row.category},${row.amount},${row.percentOfTotal}`),
    ];
    return lines.join("\n");
  }
}
