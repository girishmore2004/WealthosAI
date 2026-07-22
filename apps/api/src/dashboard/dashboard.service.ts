import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { AlertsService } from "../alerts/alerts.service";
import { PropertyService } from "../property/property.service";
import { DashboardSummaryDTO, FinancialHealthScoreDTO, InsightDTO } from "@wealthos/types";

// NOTE ON "AI": this is a deterministic rules engine, not an LLM call. It is intentionally
// explainable (every number below traces to a concrete calculation) and every output is
// clearly labeled as a projection, never as guaranteed financial advice. A grounded LLM
// chat layer (RAG over this same data) is a planned follow-up module, not part of this slice.
@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
    private expensesService: ExpensesService,
    private investmentsService: InvestmentsService,
    private loansService: LoansService,
    private alertsService: AlertsService,
    private propertyService: PropertyService,
  ) {}

  async getSummary(userId: string): Promise<DashboardSummaryDTO> {
    const currentMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"

    const [
      monthlyIncome,
      monthExpenses,
      allExpenses,
      allIncomes,
      investmentsValue,
      totalDebt,
      debtSummary,
      alerts,
      propertyValue,
    ] = await Promise.all([
      this.incomeService.monthlyForecast(userId),
      this.expensesService.list(userId, currentMonth),
      this.expensesService.list(userId),
      this.incomeService.list(userId),
      this.investmentsService.totalCurrentValue(userId),
      this.loansService.totalOutstanding(userId),
      this.loansService.debtSummary(userId),
      this.alertsService.refresh(userId),
      this.propertyService.totalCurrentValue(userId),
    ]);

    const monthlyExpenseTotal = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const savingsRate =
      monthlyIncome > 0 ? Math.max(0, (monthlyIncome - monthlyExpenseTotal) / monthlyIncome) : 0;

    // Cash balance is cumulative income minus cumulative expenses. Net worth adds
    // investment holdings and property value, and subtracts outstanding loan principal
    // (which already includes any property-linked mortgage) — the closest
    // approximation to a real balance sheet until the business-equity module exists.
    const totalIncomeAllTime = allIncomes.reduce((sum, i) => sum + Number(i.amount), 0);
    const totalExpenseAllTime = allExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const cashBalance = totalIncomeAllTime - totalExpenseAllTime;
    const netWorth = cashBalance + investmentsValue + propertyValue - totalDebt;

    const emergencyFundCategory = monthExpenses.find((e) => e.category.name === "Emergency Fund");
    const emergencyFundMonths =
      monthlyExpenseTotal > 0 && emergencyFundCategory
        ? Number(emergencyFundCategory.amount) / (monthlyExpenseTotal / 12)
        : 0;

    const healthScore = this.computeHealthScore({
      savingsRate,
      debtToIncome: monthlyIncome > 0 ? Number(debtSummary.totalMonthlyEmi) / monthlyIncome : 0,
      emergencyFundMonths,
      budgetAdherence: 1, // placeholder until user-defined budgets exist (Phase 2)
    });

    const insights = this.generateInsights({
      savingsRate,
      monthlyIncome,
      monthlyExpenseTotal,
      monthExpenses,
      debtStressScore: debtSummary.debtStressScore,
    });

    return {
      netWorth: netWorth.toFixed(2),
      cashBalance: cashBalance.toFixed(2),
      monthlyIncome: monthlyIncome.toFixed(2),
      monthlyExpenses: monthlyExpenseTotal.toFixed(2),
      savingsRate: Number((savingsRate * 100).toFixed(1)),
      healthScore,
      insights,
      investmentsValue: investmentsValue.toFixed(2),
      totalDebt: totalDebt.toFixed(2),
      propertyValue: propertyValue.toFixed(2),
      unreadAlertCount: alerts.filter((a) => !a.isRead).length,
    };
  }

  private computeHealthScore(inputs: {
    savingsRate: number;
    debtToIncome: number;
    emergencyFundMonths: number;
    budgetAdherence: number;
  }): FinancialHealthScoreDTO {
    // Weighted rubric, each sub-score normalized to 0-100 before weighting.
    const savingsScore = Math.min(100, inputs.savingsRate * 250); // 40% savings rate -> 100
    const debtScore = Math.max(0, 100 - inputs.debtToIncome * 200); // 50% DTI -> 0
    const emergencyScore = Math.min(100, (inputs.emergencyFundMonths / 6) * 100); // 6 months -> 100
    const budgetScore = inputs.budgetAdherence * 100;

    const score = Math.round(
      savingsScore * 0.35 + debtScore * 0.25 + emergencyScore * 0.25 + budgetScore * 0.15,
    );

    const band: FinancialHealthScoreDTO["band"] =
      score >= 80 ? "STRONG" : score >= 60 ? "STABLE" : score >= 40 ? "NEEDS_ATTENTION" : "AT_RISK";

    return {
      score,
      breakdown: {
        savingsRate: Math.round(savingsScore),
        debtToIncome: Math.round(debtScore),
        emergencyFundMonths: Math.round(emergencyScore),
        budgetAdherence: Math.round(budgetScore),
      },
      band,
      generatedAt: new Date().toISOString(),
    };
  }

  private generateInsights(inputs: {
    savingsRate: number;
    monthlyIncome: number;
    monthlyExpenseTotal: number;
    monthExpenses: Awaited<ReturnType<ExpensesService["list"]>>;
    debtStressScore: number;
  }): InsightDTO[] {
    const insights: InsightDTO[] = [];

    if (inputs.debtStressScore > 40) {
      insights.push({
        id: "high-debt-stress",
        title: "EMI load is high relative to income",
        detail: `Monthly EMI commitments are tracking at about ${inputs.debtStressScore}% of monthly income — above the commonly used 40% caution threshold.`,
        severity: inputs.debtStressScore > 55 ? "CRITICAL" : "WARNING",
        isProjectionOnly: true,
      });
    }

    if (inputs.savingsRate <= 0.1 && inputs.monthlyIncome > 0) {
      insights.push({
        id: "low-savings-rate",
        title: "Savings rate is below 10%",
        detail:
          "Based on this month's income and spending so far, less than a tenth of income is being saved. Consider reviewing discretionary categories.",
        severity: "WARNING",
        isProjectionOnly: true,
      });
    }

    const wantSpend = inputs.monthExpenses
      .filter((e) => e.category.type === "WANT")
      .reduce((sum, e) => sum + Number(e.amount), 0);
    if (inputs.monthlyIncome > 0 && wantSpend / inputs.monthlyIncome > 0.3) {
      insights.push({
        id: "high-discretionary-spend",
        title: "Discretionary spending is elevated",
        detail:
          "Wants-category spending is tracking above 30% of monthly income this month, projected from transactions logged so far.",
        severity: "INFO",
        isProjectionOnly: true,
      });
    }

    if (insights.length === 0) {
      insights.push({
        id: "on-track",
        title: "Finances look on track this month",
        detail: "No red flags detected from the transactions and income logged so far this month.",
        severity: "INFO",
        isProjectionOnly: true,
      });
    }

    return insights;
  }
}
