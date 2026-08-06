import { AnomalyDetectionModel } from "../src/ai/ml-insights/models/anomaly-detection.model";
import { CashflowForecastModel } from "../src/ai/ml-insights/models/cashflow-forecast.model";
import { MetricsForecastModel } from "../src/ai/ml-insights/models/metrics-forecast.model";
import { DebtRiskModel } from "../src/ai/ml-insights/models/debt-risk.model";
import { GoalSuccessModel } from "../src/ai/ml-insights/models/goal-success.model";
import { DriftDetectionModel } from "../src/ai/ml-insights/models/drift-detection.model";
import { ConceptDriftModel, ForecastActualPair } from "../src/ai/ml-insights/models/concept-drift.model";
import { FeatureMonitoringModel, MonitoredFeatureWindow } from "../src/ai/ml-insights/models/feature-monitoring.model";
import { HabitSegmentationModel } from "../src/ai/ml-insights/models/habit-segmentation.model";
import { BehavioralFeaturesModel } from "../src/ai/ml-insights/models/behavioral-features.model";
import { buildForecastActualPairs } from "../src/ai/ml-insights/history/concept-drift-pairs.util";
import { buildFeatureMonitoringWindows } from "../src/ai/ml-insights/features/feature-monitoring-windows.util";
import { ExpenseTransactionPoint, MonthlyPoint, CategoryExpensePoint } from "../src/ai/ml-insights/features/feature-extraction.service";

describe("AnomalyDetectionModel", () => {
  const model = new AnomalyDetectionModel();

  function makeTxns(
    categoryId: string,
    categoryName: string,
    amounts: number[],
    opts: { merchant?: (i: number) => string | null; isRecurring?: (i: number) => boolean; spentAt?: (i: number) => Date } = {},
  ): ExpenseTransactionPoint[] {
    return amounts.map((amount, i) => ({
      id: `${categoryId}-${i}`,
      categoryId,
      categoryName,
      amount,
      spentAt: opts.spentAt ? opts.spentAt(i) : new Date(2026, 0, i + 1),
      merchant: opts.merchant ? opts.merchant(i) : null,
      isRecurring: opts.isRecurring ? opts.isRecurring(i) : false,
    }));
  }

  it("flags a transaction far outside its category's typical range", () => {
    const txns = makeTxns("groceries", "Groceries", [1200, 1100, 1300, 1250, 1150, 1180, 50000]);
    const result = model.detect(txns);
    expect(result.prediction.some((a) => a.amount === 50000)).toBe(true);
  });

  it("does not flag anything when all transactions are close together", () => {
    const txns = makeTxns("groceries", "Groceries", [1200, 1100, 1300, 1250, 1150, 1180]);
    const result = model.detect(txns);
    expect(result.prediction).toEqual([]);
  });

  it("skips categories with too few transactions to establish a baseline", () => {
    const txns = makeTxns("rare", "Rare category", [100, 100000]); // only 2 transactions — below MIN_TRANSACTIONS_FOR_BASELINE
    const result = model.detect(txns);
    expect(result.prediction).toEqual([]);
  });

  it("includes a magnitude-based likely cause for a large outlier", () => {
    const txns = makeTxns("groceries", "Groceries", [1200, 1100, 1300, 1250, 1150, 1180, 50000]);
    const result = model.detect(txns);
    const anomaly = result.prediction.find((a) => a.amount === 50000)!;
    expect(anomaly.likelyCauses.some((c) => c.includes("x this category's typical"))).toBe(true);
  });

  it("flags a new-merchant likely cause when the outlier's merchant hasn't appeared before in the category", () => {
    const txns = makeTxns(
      "shopping",
      "Shopping",
      [1000, 1050, 950, 1020, 980, 40000],
      { merchant: (i) => (i === 5 ? "BrandNewStore" : "UsualStore") },
    );
    const result = model.detect(txns);
    const anomaly = result.prediction.find((a) => a.amount === 40000)!;
    expect(anomaly.likelyCauses.some((c) => c.includes('BrandNewStore'))).toBe(true);
  });

  it("flags a recurring-amount-change likely cause when the outlier is marked recurring", () => {
    const txns = makeTxns(
      "subscriptions",
      "Subscriptions",
      [500, 500, 500, 500, 500, 15000],
      { isRecurring: () => true },
    );
    const result = model.detect(txns);
    const anomaly = result.prediction.find((a) => a.amount === 15000)!;
    expect(anomaly.likelyCauses.some((c) => c.toLowerCase().includes("recurring"))).toBe(true);
  });

  it("always returns at least one likely cause, even when no specific rule matches", () => {
    const txns = makeTxns("groceries", "Groceries", [1200, 1100, 1300, 1250, 1150, 1180, 50000]);
    const result = model.detect(txns);
    for (const anomaly of result.prediction) {
      expect(anomaly.likelyCauses.length).toBeGreaterThan(0);
    }
  });
});

describe("CashflowForecastModel", () => {
  const model = new CashflowForecastModel();

  function makeSeries(cashflows: number[]): MonthlyPoint[] {
    return cashflows.map((netCashflow, i) => ({
      month: `2026-0${i + 1}`,
      totalExpenses: 50000,
      totalIncome: 50000 + netCashflow,
      netCashflow,
      savingsRate: netCashflow / (50000 + netCashflow),
    }));
  }

  it("projects a rising trend forward when cashflow is consistently improving", () => {
    const series = makeSeries([1000, 2000, 3000, 4000, 5000]);
    const result = model.forecast(series);
    expect(result.prediction.trendSlopePerMonth).toBeGreaterThan(0);
    expect(result.prediction.nextMonthProjectedCashflow).toBeGreaterThan(5000);
    expect(result.prediction.stressRisk).toBe(false);
  });

  it("flags stress risk when the trend projects a negative next month", () => {
    const series = makeSeries([500, 0, -500, -1000, -1500]);
    const result = model.forecast(series);
    expect(result.prediction.stressRisk).toBe(true);
  });

  it("falls back to a low-confidence repeat of the last month with too little history", () => {
    const series = makeSeries([1000, 2000]);
    const result = model.forecast(series);
    expect(result.confidence).toBeLessThan(0.5);
    expect(result.prediction.nextMonthProjectedCashflow).toBe(2000);
  });

  it("orders quantiles p10 <= p50 <= p90 and centers the 95% CI on the point forecast", () => {
    const series = makeSeries([1000, 1500, 900, 1700, 1100, 1600]);
    const result = model.forecast(series);
    const first = result.prediction.quantileForecast[0];
    expect(first.p10).toBeLessThanOrEqual(first.p50);
    expect(first.p50).toBeLessThanOrEqual(first.p90);
    const ci = result.prediction.confidenceInterval95;
    expect(ci.lower).toBeLessThanOrEqual(result.prediction.nextMonthProjectedCashflow);
    expect(ci.upper).toBeGreaterThanOrEqual(result.prediction.nextMonthProjectedCashflow);
  });

  it("surfaces the user's own personalized baseline mean/stdDev", () => {
    const series = makeSeries([1000, 2000, 3000, 4000, 5000]);
    const result = model.forecast(series);
    expect(result.prediction.personalizedBaseline.historicalMean).toBeCloseTo(3000, 0);
    expect(result.prediction.personalizedBaseline.historicalStdDev).toBeGreaterThan(0);
  });

  it("does not report seasonality with fewer than 24 months of history", () => {
    const series = makeSeries([1000, 1500, 900, 1700, 1100, 1600]);
    const result = model.forecast(series);
    expect(result.prediction.decomposition.hasSeasonality).toBe(false);
    expect(result.prediction.decomposition.seasonalAdjustmentThisMonth).toBe(0);
  });
});

describe("MetricsForecastModel", () => {
  const model = new MetricsForecastModel();

  function makeSeries(rows: { income: number; expenses: number }[]): MonthlyPoint[] {
    return rows.map((r, i) => ({
      month: `2026-${String((i % 12) + 1).padStart(2, "0")}`,
      totalExpenses: r.expenses,
      totalIncome: r.income,
      netCashflow: r.income - r.expenses,
      savingsRate: r.income > 0 ? (r.income - r.expenses) / r.income : 0,
    }));
  }

  it("forecasts income and expenses independently, each with ordered quantiles", () => {
    const series = makeSeries([
      { income: 50000, expenses: 30000 },
      { income: 52000, expenses: 31000 },
      { income: 54000, expenses: 29000 },
      { income: 56000, expenses: 32000 },
      { income: 58000, expenses: 30000 },
    ]);
    const result = model.forecast(series);
    expect(result.prediction.insufficientHistory).toBe(false);
    for (const metric of [result.prediction.income, result.prediction.expenses, result.prediction.savingsRate]) {
      const first = metric.quantileForecast[0];
      expect(first.p10).toBeLessThanOrEqual(first.p50);
      expect(first.p50).toBeLessThanOrEqual(first.p90);
    }
    // Income is rising and expenses are roughly flat — income's trend slope should be
    // clearly positive, distinctly different information from the combined cashflow
    // number alone.
    expect(result.prediction.income.trendSlopePerMonth).toBeGreaterThan(0);
  });

  it("flags insufficient history and returns flat carry-forward estimates with too few months", () => {
    const series = makeSeries([
      { income: 50000, expenses: 30000 },
      { income: 51000, expenses: 29000 },
    ]);
    const result = model.forecast(series);
    expect(result.prediction.insufficientHistory).toBe(true);
    expect(result.confidence).toBeLessThan(0.5);
  });
});

describe("DebtRiskModel", () => {
  const model = new DebtRiskModel();

  it("returns a zero, certain score when there are no loans", () => {
    const result = model.score({ totalOutstanding: 0, totalMonthlyEmi: 0, monthlyIncome: 100000, loans: [] });
    expect(result.prediction.riskScore).toBe(0);
    expect(result.prediction.tier).toBe("low");
    expect(result.confidence).toBe(1);
  });

  it("scores a high EMI burden with a high interest rate as high/severe risk", () => {
    const result = model.score({
      totalOutstanding: 1000000,
      totalMonthlyEmi: 55000, // 55% of income
      monthlyIncome: 100000,
      loans: [{ outstandingPrincipal: 1000000, interestRateAnnual: 22 }],
    });
    expect(["high", "severe"]).toContain(result.prediction.tier);
  });

  it("scores a modest EMI burden with a low interest rate as low risk", () => {
    const result = model.score({
      totalOutstanding: 500000,
      totalMonthlyEmi: 8000, // 8% of income
      monthlyIncome: 100000,
      loans: [{ outstandingPrincipal: 500000, interestRateAnnual: 7 }],
    });
    expect(result.prediction.tier).toBe("low");
  });

  it("ranks contributing features by their actual weighted contribution", () => {
    const result = model.score({
      totalOutstanding: 1000000,
      totalMonthlyEmi: 55000,
      monthlyIncome: 100000,
      loans: [{ outstandingPrincipal: 1000000, interestRateAnnual: 22 }],
    });
    const contributions = result.contributingFeatures.map((f) => f.contribution);
    expect(contributions).toEqual([...contributions].sort((a, b) => b - a));
  });
});

describe("GoalSuccessModel", () => {
  const model = new GoalSuccessModel();

  // The model now reads contributionPaceRatio/progressPercent/probabilityOfSuccess
  // directly from GoalDTO — the exact fields GoalsService.enrich() already computes —
  // rather than recomputing a ratio from raw monthlyContribution/requiredMonthlyContribution
  // itself. makeGoal mirrors a full GoalDTO so these tests exercise the model the same
  // way the real GoalsService output would.
  function makeGoal(overrides: {
    contributionPaceRatio: number;
    progressPercent?: number;
    probabilityOfSuccess?: "ON_TRACK" | "AT_RISK" | "OFF_TRACK";
    name?: string;
  }) {
    return {
      id: "g1",
      userId: "u1",
      type: "OTHER" as const,
      name: overrides.name ?? "Test goal",
      targetAmount: "0",
      targetDate: "2030-01",
      currentAmount: "0",
      monthlyContribution: "0",
      linkedInvestmentValue: "0",
      requiredMonthlyContribution: 0,
      progressPercent: overrides.progressPercent ?? 0,
      probabilityOfSuccess: overrides.probabilityOfSuccess ?? "ON_TRACK",
      contributionPaceRatio: overrides.contributionPaceRatio,
      isPaceHeuristic: true as const,
      projectedInvestmentValueAtTarget: "0",
      assumedAnnualReturnPercent: "0",
    };
  }

  it("gives exactly 50% probability when the pace ratio is exactly 1 (on pace exactly)", () => {
    const result = model.score([makeGoal({ contributionPaceRatio: 1, progressPercent: 40, probabilityOfSuccess: "ON_TRACK" })]);
    expect(result.prediction[0].successProbability).toBeCloseTo(0.5, 2);
  });

  it("gives a high probability when the pace ratio is well above 1", () => {
    const result = model.score([makeGoal({ contributionPaceRatio: 2, progressPercent: 40, probabilityOfSuccess: "ON_TRACK" })]);
    expect(result.prediction[0].successProbability).toBeGreaterThan(0.8);
  });

  it("gives a low probability when the pace ratio is well below 1", () => {
    const result = model.score([makeGoal({ contributionPaceRatio: 0.2, progressPercent: 10, probabilityOfSuccess: "OFF_TRACK" })]);
    expect(result.prediction[0].successProbability).toBeLessThan(0.2);
  });

  it("treats a goal already fully funded today (progressPercent >= 100) as certain success regardless of pace ratio", () => {
    const result = model.score([makeGoal({ contributionPaceRatio: 1, progressPercent: 100, probabilityOfSuccess: "ON_TRACK" })]);
    expect(result.prediction[0].successProbability).toBe(1);
  });

  it("carries GoalsService's ruleBasedTier through unchanged", () => {
    const result = model.score([makeGoal({ contributionPaceRatio: 0.7, progressPercent: 50, probabilityOfSuccess: "AT_RISK" })]);
    expect(result.prediction[0].ruleBasedTier).toBe("AT_RISK");
  });

  it("flags agreement when the statistical read and the rule-based tier point the same direction", () => {
    // ratio 1.5 -> well above 50% statistically; AT_RISK reads as "on pace" (only
    // OFF_TRACK reads as not-on-pace) -> both say "on pace" -> agree.
    const result = model.score([makeGoal({ contributionPaceRatio: 1.5, progressPercent: 60, probabilityOfSuccess: "AT_RISK" })]);
    expect(result.prediction[0].agreesWithRuleBasedTier).toBe(true);
  });

  it("flags disagreement when the statistical read and the rule-based tier point different directions", () => {
    // ratio 1.5 -> well above 50% statistically ("on pace"), but GoalsService says
    // OFF_TRACK ("not on pace") -> disagreement, and it should be called out in the
    // explanation text so it's not a silent inconsistency.
    const result = model.score([makeGoal({ contributionPaceRatio: 1.5, progressPercent: 60, probabilityOfSuccess: "OFF_TRACK", name: "Disagreeing Goal" })]);
    expect(result.prediction[0].agreesWithRuleBasedTier).toBe(false);
    expect(result.explanation).toContain("Disagreeing Goal");
  });

  it("reports no goals set yet when given an empty list", () => {
    const result = model.score([]);
    expect(result.explanation).toBe("No goals set yet.");
    expect(result.confidence).toBe(0);
  });
});

describe("DriftDetectionModel", () => {
  const model = new DriftDetectionModel();

  function makeSeries(savingsRates: number[]): MonthlyPoint[] {
    return savingsRates.map((savingsRate, i) => ({ month: `m${i}`, totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate }));
  }

  it("detects a significant improvement in savings rate between two windows", () => {
    const series = makeSeries([0.1, 0.1, 0.1, 0.4, 0.4, 0.4]);
    const result = model.detect(series);
    expect(result.prediction.drifted).toBe(true);
    expect(result.prediction.direction).toBe("improving");
  });

  it("detects a significant worsening in savings rate", () => {
    const series = makeSeries([0.4, 0.4, 0.4, 0.1, 0.1, 0.1]);
    const result = model.detect(series);
    expect(result.prediction.drifted).toBe(true);
    expect(result.prediction.direction).toBe("worsening");
  });

  it("finds no drift when the rate is stable", () => {
    const series = makeSeries([0.2, 0.21, 0.19, 0.2, 0.21, 0.19]);
    const result = model.detect(series);
    expect(result.prediction.drifted).toBe(false);
  });

  it("returns 0 confidence with too little history", () => {
    const series = makeSeries([0.2, 0.2]);
    const result = model.detect(series);
    expect(result.confidence).toBe(0);
  });
});

describe("HabitSegmentationModel", () => {
  const model = new HabitSegmentationModel();

  function makeSeries(savingsRates: number[]): MonthlyPoint[] {
    return savingsRates.map((savingsRate, i) => ({ month: `2026-0${i + 1}`, totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate }));
  }

  it("classifies a month well above the user's own average as high_saving", () => {
    const series = makeSeries([0.1, 0.1, 0.1, 0.1, 0.9]);
    const result = model.segment(series);
    expect(result.prediction[result.prediction.length - 1].state).toBe("high_saving");
  });

  it("classifies a month well below the user's own average as overspending", () => {
    const series = makeSeries([0.5, 0.5, 0.5, 0.5, -0.5]);
    const result = model.segment(series);
    expect(result.prediction[result.prediction.length - 1].state).toBe("overspending");
  });

  it("classifies a recent month within its own normal range as balanced", () => {
    const series = makeSeries([0.2, 0.202, 0.198, 0.201, 0.199, 0.203, 0.197, 0.2]);
    const result = model.segment(series);
    expect(result.prediction[result.prediction.length - 1].state).toBe("balanced");
  });

  it("returns 0 confidence with too little history to establish a personal baseline", () => {
    const series = makeSeries([0.2, 0.2]);
    const result = model.segment(series);
    expect(result.confidence).toBe(0);
    expect(result.prediction).toEqual([]);
  });
});

describe("ConceptDriftModel", () => {
  const model = new ConceptDriftModel();

  function makePairs(errors: number[]): ForecastActualPair[] {
    return errors.map((err, i) => ({
      targetMonth: `2026-${String(i + 1).padStart(2, "0")}`,
      predictedNetCashflow: 1000,
      actualNetCashflow: 1000 - err, // err is the absolute forecast error for that month
    }));
  }

  it("reports not monitored with fewer than 6 resolved forecast-actual pairs", () => {
    const result = model.detect(makePairs([100, 100, 100]));
    expect(result.prediction.monitored).toBe(false);
    expect(result.prediction.driftDetected).toBe(false);
  });

  it("detects degrading accuracy when recent forecast error is clearly worse than prior error", () => {
    const result = model.detect(makePairs([50, 50, 50, 800, 800, 800]));
    expect(result.prediction.monitored).toBe(true);
    expect(result.prediction.driftDetected).toBe(true);
    expect(result.prediction.direction).toBe("degrading");
  });

  it("detects improving accuracy when recent forecast error is clearly better than prior error", () => {
    const result = model.detect(makePairs([800, 800, 800, 50, 50, 50]));
    expect(result.prediction.direction).toBe("improving");
  });

  it("finds no drift when forecast error is stable across windows", () => {
    const result = model.detect(makePairs([100, 105, 95, 100, 98, 102]));
    expect(result.prediction.driftDetected).toBe(false);
    expect(result.prediction.direction).toBe("stable");
  });
});

describe("buildForecastActualPairs", () => {
  function makeMonthlySeries(months: Record<string, number>): MonthlyPoint[] {
    return Object.entries(months).map(([month, netCashflow]) => ({
      month,
      totalExpenses: 1000,
      totalIncome: 1000 + netCashflow,
      netCashflow,
      savingsRate: 0.1,
    }));
  }

  it("pairs a past run's forecast against the now-resolved actual for its target month", () => {
    const runs = [{ createdAt: new Date(2026, 0, 15), predictedNextMonthCashflow: 500 }]; // targets 2026-02
    const monthlySeries = makeMonthlySeries({ "2026-02": 450 });
    const pairs = buildForecastActualPairs(runs, monthlySeries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].targetMonth).toBe("2026-02");
    expect(pairs[0].predictedNetCashflow).toBe(500);
    expect(pairs[0].actualNetCashflow).toBe(450);
  });

  it("skips a run whose target month hasn't resolved yet (no matching actual data)", () => {
    const runs = [{ createdAt: new Date(2026, 0, 15), predictedNextMonthCashflow: 500 }];
    const pairs = buildForecastActualPairs(runs, []);
    expect(pairs).toHaveLength(0);
  });

  it("keeps only the latest run for a given target month when duplicates exist", () => {
    const runs = [
      { createdAt: new Date(2026, 0, 20), predictedNextMonthCashflow: 700 }, // more recent, targets 2026-02
      { createdAt: new Date(2026, 0, 5), predictedNextMonthCashflow: 500 }, // earlier, also targets 2026-02
    ];
    const monthlySeries = makeMonthlySeries({ "2026-02": 450 });
    const pairs = buildForecastActualPairs(runs, monthlySeries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].predictedNetCashflow).toBe(700);
  });
});

describe("FeatureMonitoringModel", () => {
  const model = new FeatureMonitoringModel();

  function makeWindow(name: string, reference: number[], current: number[]): MonitoredFeatureWindow {
    return { name, reference, current };
  }

  it("reports not monitored when there isn't enough data per window", () => {
    const result = model.detect([makeWindow("tiny", [1, 2], [1, 2])]);
    expect(result.prediction.monitored).toBe(false);
  });

  it("finds no shift when reference and current windows match", () => {
    const values = Array.from({ length: 20 }, (_, i) => i);
    const result = model.detect([makeWindow("stable", values, values)]);
    expect(result.prediction.anyShiftDetected).toBe(false);
    expect(result.prediction.features[0].severity).toBe("none");
  });

  it("flags a significant shift when the current window has moved entirely outside the reference range", () => {
    const reference = Array.from({ length: 20 }, (_, i) => i);
    const current = Array.from({ length: 20 }, (_, i) => i + 1000);
    const result = model.detect([makeWindow("shifted", reference, current)]);
    expect(result.prediction.anyShiftDetected).toBe(true);
    expect(result.prediction.features[0].severity).toBe("significant");
  });
});

describe("buildFeatureMonitoringWindows", () => {
  function makeTxn(categoryId: string, amount: number, spentAt: Date): ExpenseTransactionPoint {
    return { id: `${categoryId}-${spentAt.getTime()}`, categoryId, categoryName: categoryId, amount, spentAt };
  }

  it("splits transactions into a reference window (older) and a current window (most recent months)", () => {
    const monthlySeries: MonthlyPoint[] = [
      { month: "2026-01", totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate: 0.5 },
      { month: "2026-02", totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate: 0.5 },
      { month: "2026-03", totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate: 0.5 },
      { month: "2026-04", totalExpenses: 100, totalIncome: 200, netCashflow: 100, savingsRate: 0.5 },
    ];
    const transactions = [
      makeTxn("groceries", 100, new Date(2026, 0, 5)),
      makeTxn("groceries", 110, new Date(2026, 1, 5)),
      makeTxn("groceries", 900, new Date(2026, 3, 5)), // in the "current" (last 3 months) window
    ];
    const windows = buildFeatureMonitoringWindows(transactions, monthlySeries);
    const amountWindow = windows.find((w) => w.name.includes("Avg transaction amount"))!;
    expect(amountWindow.current).toContain(900);
    expect(amountWindow.reference).not.toContain(900);
  });

  it("returns an empty list when there are no active months yet", () => {
    expect(buildFeatureMonitoringWindows([], [])).toEqual([]);
  });
});

describe("BehavioralFeaturesModel", () => {
  const model = new BehavioralFeaturesModel();

  function makeMonthlySeries(savingsRates: number[]): MonthlyPoint[] {
    return savingsRates.map((savingsRate, i) => ({
      month: `2026-${String(i + 1).padStart(2, "0")}`,
      totalExpenses: 40000,
      totalIncome: 50000,
      netCashflow: 50000 * savingsRate,
      savingsRate,
    }));
  }

  it("classifies a consistently high, low-volatility saver as disciplined_saver", () => {
    const result = model.extract({
      monthlySeries: makeMonthlySeries([0.3, 0.31, 0.29, 0.3, 0.3]),
      transactions: [],
      categorySeries: [],
    });
    expect(result.prediction.cluster).toBe("disciplined_saver");
  });

  it("classifies negative average savings as overspender", () => {
    const result = model.extract({
      monthlySeries: makeMonthlySeries([-0.1, -0.2, -0.05, -0.15, -0.1]),
      transactions: [],
      categorySeries: [],
    });
    expect(result.prediction.cluster).toBe("overspender");
  });

  it("classifies highly concentrated recent spending as concentrated_spender", () => {
    const categorySeries: CategoryExpensePoint[] = [
      { categoryId: "rent", categoryName: "Rent", month: "2026-03", total: 38000 },
      { categoryId: "misc", categoryName: "Misc", month: "2026-03", total: 2000 },
      { categoryId: "rent", categoryName: "Rent", month: "2026-04", total: 38000 },
      { categoryId: "misc", categoryName: "Misc", month: "2026-04", total: 2000 },
      { categoryId: "rent", categoryName: "Rent", month: "2026-05", total: 38000 },
      { categoryId: "misc", categoryName: "Misc", month: "2026-05", total: 2000 },
    ];
    const result = model.extract({
      monthlySeries: makeMonthlySeries([0.1, 0.12, 0.1, 0.11, 0.1]),
      transactions: [],
      categorySeries,
    });
    expect(result.prediction.cluster).toBe("concentrated_spender");
    expect(result.prediction.features.topCategoryName).toBe("Rent");
  });

  it("returns 0 confidence with too little history", () => {
    const result = model.extract({ monthlySeries: makeMonthlySeries([0.1, 0.1]), transactions: [], categorySeries: [] });
    expect(result.confidence).toBe(0);
  });
});
