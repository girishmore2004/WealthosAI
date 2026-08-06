import { Injectable } from "@nestjs/common";
import { MonthlyPoint, ExpenseTransactionPoint, CategoryExpensePoint } from "../features/feature-extraction.service";
import { mean, coefficientOfVariation, herfindahlIndex, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export type SpendingCluster = "disciplined_saver" | "steady_balanced" | "volatile_spender" | "concentrated_spender" | "overspender";

export interface BehavioralFeatureVector {
  avgSavingsRate: number;
  expenseVolatilityCV: number;
  recurringSpendShare: number;
  categoryConcentrationHHI: number;
  topCategoryName: string | null;
  topCategoryShare: number;
}

export interface BehavioralFeatureResult {
  features: BehavioralFeatureVector;
  cluster: SpendingCluster;
}

export interface BehavioralFeatureInput {
  monthlySeries: MonthlyPoint[];
  transactions: ExpenseTransactionPoint[];
  categorySeries: CategoryExpensePoint[];
}

const MIN_MONTHS = 4;
const CONCENTRATION_WINDOW_MONTHS = 3;
const VOLATILE_CV_THRESHOLD = 0.35;
const CONCENTRATED_HHI_THRESHOLD = 0.4;
const DISCIPLINED_SAVINGS_RATE_THRESHOLD = 0.25;
const DISCIPLINED_MAX_CV = 0.2;

// User-specific feature engineering: turns raw transactions/monthly totals into a
// small, named vector of BEHAVIORAL features (not just "how much did you spend" but
// "how do you spend") — the same handful of signals a human financial coach would
// eyeball: how much expenses vary month to month, how concentrated spend is in a few
// categories, how much is locked-in recurring vs. discretionary. Cluster assignment
// below is a hand-specified rule tree over these features, not a fitted/trained
// clustering model — same honesty framing as HabitSegmentationModel and
// DebtRiskModel's scorecard elsewhere in this module: this app has no labeled cohort
// of "true" spending personas to fit centroids against, so the STRUCTURE (a real
// multi-feature classification over genuinely engineered statistics) is honest, but
// the specific thresholds below are documented, reviewable judgment calls, not
// learned parameters — exactly the same caveat DebtRiskModel/GoalSuccessModel already
// carry for their own scorecards.
@Injectable()
export class BehavioralFeaturesModel {
  extract(input: BehavioralFeatureInput): ModelOutput<BehavioralFeatureResult> {
    const activeMonths = input.monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0);

    if (activeMonths.length < MIN_MONTHS) {
      return {
        method:
          "Hand-specified rule tree over engineered behavioral features (savings-rate level, expense-volatility CV, category-concentration HHI, recurring-spend share) — not fitted to labeled clusters",
        prediction: {
          features: {
            avgSavingsRate: 0,
            expenseVolatilityCV: 0,
            recurringSpendShare: 0,
            categoryConcentrationHHI: 0,
            topCategoryName: null,
            topCategoryShare: 0,
          },
          cluster: "steady_balanced",
        },
        confidence: 0,
        contributingFeatures: [],
        explanation: `Need at least ${MIN_MONTHS} months of activity to build a reliable personal behavioral profile — only ${activeMonths.length} available.`,
      };
    }

    const avgSavingsRate = mean(activeMonths.map((m) => m.savingsRate));
    const expenseVolatilityCV = coefficientOfVariation(activeMonths.map((m) => m.totalExpenses));

    const totalSpend = input.transactions.reduce((s, t) => s + t.amount, 0);
    const recurringSpend = input.transactions.filter((t) => t.isRecurring).reduce((s, t) => s + t.amount, 0);
    const recurringSpendShare = totalSpend > 0 ? recurringSpend / totalSpend : 0;

    const recentMonths = new Set(activeMonths.slice(-CONCENTRATION_WINDOW_MONTHS).map((m) => m.month));
    const recentCategorySeries = input.categorySeries.filter((c) => recentMonths.has(c.month));
    const totalsByCategory = new Map<string, { name: string; total: number }>();
    for (const c of recentCategorySeries) {
      const existing = totalsByCategory.get(c.categoryId);
      totalsByCategory.set(c.categoryId, { name: c.categoryName, total: (existing?.total ?? 0) + c.total });
    }
    const categoryTotals = [...totalsByCategory.values()];
    const categoryConcentrationHHI = herfindahlIndex(categoryTotals.map((c) => c.total));
    const recentTotalSpend = categoryTotals.reduce((s, c) => s + c.total, 0);
    const topCategory = [...categoryTotals].sort((a, b) => b.total - a.total)[0] ?? null;
    const topCategoryShare = topCategory && recentTotalSpend > 0 ? topCategory.total / recentTotalSpend : 0;

    const features: BehavioralFeatureVector = {
      avgSavingsRate: Number(avgSavingsRate.toFixed(4)),
      expenseVolatilityCV: Number(expenseVolatilityCV.toFixed(4)),
      recurringSpendShare: Number(recurringSpendShare.toFixed(4)),
      categoryConcentrationHHI: Number(categoryConcentrationHHI.toFixed(4)),
      topCategoryName: topCategory?.name ?? null,
      topCategoryShare: Number(topCategoryShare.toFixed(4)),
    };

    const cluster = this.assignCluster(features);

    return {
      method:
        "Hand-specified rule tree over engineered behavioral features (savings-rate level, expense-volatility CV, category-concentration HHI, recurring-spend share) — not fitted to labeled clusters",
      prediction: { features, cluster },
      confidence: clamp01(activeMonths.length / 12),
      contributingFeatures: [
        { name: "Avg savings rate", value: features.avgSavingsRate, contribution: Math.abs(features.avgSavingsRate) },
        { name: "Expense volatility (CV)", value: features.expenseVolatilityCV, contribution: features.expenseVolatilityCV },
        { name: "Category concentration (HHI)", value: features.categoryConcentrationHHI, contribution: features.categoryConcentrationHHI },
        { name: "Recurring spend share", value: features.recurringSpendShare, contribution: features.recurringSpendShare },
      ],
      explanation: this.describeCluster(cluster, features),
    };
  }

  private assignCluster(f: BehavioralFeatureVector): SpendingCluster {
    if (f.avgSavingsRate < 0) return "overspender";
    if (f.expenseVolatilityCV >= VOLATILE_CV_THRESHOLD) return "volatile_spender";
    if (f.categoryConcentrationHHI >= CONCENTRATED_HHI_THRESHOLD) return "concentrated_spender";
    if (f.avgSavingsRate >= DISCIPLINED_SAVINGS_RATE_THRESHOLD && f.expenseVolatilityCV < DISCIPLINED_MAX_CV) return "disciplined_saver";
    return "steady_balanced";
  }

  private describeCluster(cluster: SpendingCluster, f: BehavioralFeatureVector): string {
    switch (cluster) {
      case "overspender":
        return `Average savings rate is negative (${(f.avgSavingsRate * 100).toFixed(1)}%) — spending has exceeded income on average over the monitored period.`;
      case "volatile_spender":
        return `Monthly expenses vary a lot month to month (coefficient of variation ${f.expenseVolatilityCV.toFixed(2)}) — spending is irregular rather than following a steady pattern.`;
      case "concentrated_spender":
        return `Spending is concentrated in a small number of categories (concentration index ${f.categoryConcentrationHHI.toFixed(2)}${
          f.topCategoryName ? `, led by "${f.topCategoryName}" at ${(f.topCategoryShare * 100).toFixed(0)}% of recent spend` : ""
        }).`;
      case "disciplined_saver":
        return `Consistently saving a healthy share of income (avg ${(f.avgSavingsRate * 100).toFixed(1)}%) with low month-to-month expense volatility (CV ${f.expenseVolatilityCV.toFixed(2)}).`;
      default:
        return `Spending is broadly steady and balanced — avg savings rate ${(f.avgSavingsRate * 100).toFixed(1)}%, expense volatility CV ${f.expenseVolatilityCV.toFixed(2)}.`;
    }
  }
}
