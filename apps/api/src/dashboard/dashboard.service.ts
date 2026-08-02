import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { AlertsService } from "../alerts/alerts.service";
import { PropertyService } from "../property/property.service";
import { UpsertBudgetDto } from "./dto/upsert-budget.dto";
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

  // --- Budgets (new) -------------------------------------------------------------
  // The whole point of this addition: give budgetAdherence a real, user-defined signal
  // instead of the previous hardcoded placeholder. One budget per category per user
  // (upsertBudget is a genuine upsert — setting a category's budget again just updates
  // the existing amount rather than erroring or duplicating).

  listBudgets(userId: string) {
    return this.prisma.client.budget.findMany({
      where: { userId },
      include: { category: true },
      orderBy: { monthlyAmount: "desc" },
    });
  }

  upsertBudget(userId: string, dto: UpsertBudgetDto) {
    return this.prisma.client.budget.upsert({
      where: { userId_categoryId: { userId, categoryId: dto.categoryId } },
      create: { userId, categoryId: dto.categoryId, monthlyAmount: dto.monthlyAmount },
      update: { monthlyAmount: dto.monthlyAmount },
      include: { category: true },
    });
  }

  async removeBudget(userId: string, id: string) {
    const result = await this.prisma.client.budget.deleteMany({ where: { id, userId } });
    if (result.count === 0) {
      throw new NotFoundException("Budget not found");
    }
    return { id };
  }

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
      budgets,
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
      this.prisma.client.budget.findMany({ where: { userId } }),
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

    const budgetAdherence = this.computeBudgetAdherence(budgets, monthExpenses);

    const healthScore = this.computeHealthScore({
      savingsRate,
      debtToIncome: monthlyIncome > 0 ? Number(debtSummary.totalMonthlyEmi) / monthlyIncome : 0,
      emergencyFundMonths,
      budgetAdherence: budgetAdherence.score,
      budgetAdherenceIsReal: budgetAdherence.isReal,
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

  // Replaces the previous hardcoded `budgetAdherence: 1` placeholder — audit: "15% of
  // everyone's health score is currently a constant, not a real signal... the single
  // most impactful 'silently not real' number in the whole app."
  //
  // For each category the user has a budget set for: 1.0 (full credit) if this month's
  // spend is at or under budget; otherwise degrades linearly with the overspend ratio,
  // floored at 0 once spend reaches double the budget. Per-category scores are
  // averaged WEIGHTED BY BUDGET AMOUNT (not a simple average) — a ₹500 grocery budget
  // blown by 50% shouldn't move the aggregate as much as a ₹50,000 rent budget missed
  // by the same percentage.
  //
  // isReal=false (no budgets configured at all) is the honest alternative to a fake
  // number — computeHealthScore() below redistributes this dimension's weight across
  // the other three rather than trusting a placeholder, directly implementing the
  // audit's stated fallback option for users who haven't set up budgets yet.
  private computeBudgetAdherence(
    budgets: { categoryId: string; monthlyAmount: unknown }[],
    monthExpenses: { categoryId: string; amount: unknown }[],
  ): { score: number; isReal: boolean } {
    if (budgets.length === 0) {
      return { score: 1, isReal: false };
    }

    const spentByCategory = new Map<string, number>();
    for (const e of monthExpenses) {
      spentByCategory.set(e.categoryId, (spentByCategory.get(e.categoryId) ?? 0) + Number(e.amount));
    }

    let weightedAdherenceSum = 0;
    let totalBudgetWeight = 0;
    for (const b of budgets) {
      const budgetAmount = Number(b.monthlyAmount);
      if (budgetAmount <= 0) continue;
      const spent = spentByCategory.get(b.categoryId) ?? 0;
      const categoryAdherence =
        spent <= budgetAmount ? 1 : Math.max(0, 1 - (spent - budgetAmount) / budgetAmount);
      weightedAdherenceSum += categoryAdherence * budgetAmount;
      totalBudgetWeight += budgetAmount;
    }

    const score = totalBudgetWeight > 0 ? weightedAdherenceSum / totalBudgetWeight : 1;
    return { score, isReal: true };
  }

  private computeHealthScore(inputs: {
    savingsRate: number;
    debtToIncome: number;
    emergencyFundMonths: number;
    budgetAdherence: number;
    budgetAdherenceIsReal: boolean;
  }): FinancialHealthScoreDTO {
    // Weighted rubric, each sub-score normalized to 0-100 before weighting.
    const savingsScore = Math.min(100, inputs.savingsRate * 250); // 40% savings rate -> 100
    const debtScore = Math.max(0, 100 - inputs.debtToIncome * 200); // 50% DTI -> 0
    const emergencyScore = Math.min(100, (inputs.emergencyFundMonths / 6) * 100); // 6 months -> 100
    const budgetScore = inputs.budgetAdherence * 100;

    const BASE_WEIGHTS = { savings: 0.35, debt: 0.25, emergency: 0.25, budget: 0.15 };

    // No budgets configured -> redistribute the budget dimension's weight
    // proportionally across the other three, so the overall score is computed
    // entirely from real signals rather than partly from a fabricated one.
    const weights = inputs.budgetAdherenceIsReal
      ? BASE_WEIGHTS
      : {
          savings: BASE_WEIGHTS.savings / (1 - BASE_WEIGHTS.budget),
          debt: BASE_WEIGHTS.debt / (1 - BASE_WEIGHTS.budget),
          emergency: BASE_WEIGHTS.emergency / (1 - BASE_WEIGHTS.budget),
          budget: 0,
        };

    const score = Math.round(
      savingsScore * weights.savings +
        debtScore * weights.debt +
        emergencyScore * weights.emergency +
        budgetScore * weights.budget,
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
      // NEW: tells the frontend whether budgetAdherence above reflects real
      // user-defined budgets or is an unweighted placeholder (currently always 100 in
      // that case, for calculation continuity) that shouldn't be displayed as a
      // meaningful figure on its own — e.g. "Set a budget to include this in your score"
      // instead of showing a number that was never actually measured.
      budgetAdherenceIsReal: inputs.budgetAdherenceIsReal,
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
