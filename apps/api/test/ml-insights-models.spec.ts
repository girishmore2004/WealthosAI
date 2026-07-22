import { AnomalyDetectionModel } from "../src/ai/ml-insights/models/anomaly-detection.model";
import { CashflowForecastModel } from "../src/ai/ml-insights/models/cashflow-forecast.model";
import { DebtRiskModel } from "../src/ai/ml-insights/models/debt-risk.model";
import { GoalSuccessModel } from "../src/ai/ml-insights/models/goal-success.model";
import { DriftDetectionModel } from "../src/ai/ml-insights/models/drift-detection.model";
import { HabitSegmentationModel } from "../src/ai/ml-insights/models/habit-segmentation.model";
import { ExpenseTransactionPoint, MonthlyPoint } from "../src/ai/ml-insights/features/feature-extraction.service";

describe("AnomalyDetectionModel", () => {
  const model = new AnomalyDetectionModel();

  function makeTxns(categoryId: string, categoryName: string, amounts: number[]): ExpenseTransactionPoint[] {
    return amounts.map((amount, i) => ({ id: `${categoryId}-${i}`, categoryId, categoryName, amount, spentAt: new Date() }));
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

  function makeGoal(monthlyContribution: number, requiredMonthlyContribution: number) {
    return { id: "g1", userId: "u1", type: "OTHER" as const, name: "Test goal", targetAmount: "0", targetDate: "2030-01", currentAmount: "0", monthlyContribution: String(monthlyContribution), linkedInvestmentValue: "0", requiredMonthlyContribution, progressPercent: 0, probabilityOfSuccess: "ON_TRACK" as const };
  }

  it("gives exactly 50% probability when committed contribution exactly matches what's required", () => {
    const result = model.score([makeGoal(5000, 5000)]);
    expect(result.prediction[0].successProbability).toBeCloseTo(0.5, 2);
  });

  it("gives a high probability when contributing well above what's required", () => {
    const result = model.score([makeGoal(10000, 5000)]);
    expect(result.prediction[0].successProbability).toBeGreaterThan(0.8);
  });

  it("gives a low probability when contributing well below what's required", () => {
    const result = model.score([makeGoal(1000, 5000)]);
    expect(result.prediction[0].successProbability).toBeLessThan(0.2);
  });

  it("treats an already-fully-funded goal (required <= 0) as certain success", () => {
    const result = model.score([makeGoal(0, 0)]);
    expect(result.prediction[0].successProbability).toBeGreaterThan(0.9);
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
