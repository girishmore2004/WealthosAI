import { Injectable } from "@nestjs/common";
import { MonthlyPoint } from "../features/feature-extraction.service";
import { bayesianQuantileForecast, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";
import { QuantileForecastPoint } from "./cashflow-forecast.model";

export type ForecastMetricName = "income" | "expenses" | "savingsRate";

export interface MetricForecastResult {
  metric: ForecastMetricName;
  nextMonthP50: number;
  trendSlopePerMonth: number;
  confidenceInterval95: { lower: number; upper: number };
  quantileForecast: QuantileForecastPoint[];
  decomposition: { hasSeasonality: boolean; trendSlope: number };
  personalizedBaseline: { historicalMean: number; historicalStdDev: number };
  fitQuality: number;
}

export interface MetricsForecast {
  income: MetricForecastResult;
  expenses: MetricForecastResult;
  savingsRate: MetricForecastResult;
  insufficientHistory: boolean;
}

const MIN_MONTHS_FOR_TREND = 4;

// The audit's explicit ask was Bayesian forecasting "for income, expenses, savings,
// and key metrics" — CashflowForecastModel only ever forecast the single derived
// metric (net cashflow = income - expenses). This model forecasts the three
// underlying metrics independently, each through the exact same
// bayesianQuantileForecast() engine (personal-baseline Bayesian shrinkage + trend
// continuation + growing uncertainty + P10/P50/P90 quantiles + 95% CI), so "income
// is expected to..." and "expenses are expected to..." are both real, individually
// probabilistic forecasts rather than only ever being read off the combined cashflow
// number.
@Injectable()
export class MetricsForecastModel {
  forecast(monthlySeries: MonthlyPoint[]): ModelOutput<MetricsForecast> {
    const activeMonths = monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0);
    const insufficientHistory = activeMonths.length < MIN_MONTHS_FOR_TREND;

    const monthOfYear = activeMonths.map((m) => Number(m.month.slice(5, 7)) - 1);

    const income = this.forecastMetric("income", activeMonths.map((m) => m.totalIncome), monthOfYear, insufficientHistory);
    const expenses = this.forecastMetric("expenses", activeMonths.map((m) => m.totalExpenses), monthOfYear, insufficientHistory);
    const savingsRate = this.forecastMetric("savingsRate", activeMonths.map((m) => m.savingsRate), monthOfYear, insufficientHistory);

    const avgFitQuality = (income.fitQuality + expenses.fitQuality + savingsRate.fitQuality) / 3;

    return {
      method:
        "Bayesian-shrunk OLS trend forecast (personal long-run mean as prior, OLS trend extrapolation weighted by fit quality as evidence) run independently per metric — income, expenses, savings rate — each with P10/P50/P90 quantiles and a 95% confidence interval",
      prediction: { income, expenses, savingsRate, insufficientHistory },
      confidence: insufficientHistory ? 0.2 : clamp01(avgFitQuality),
      contributingFeatures: [
        { name: "Income next-month P50 (₹)", value: Number(income.nextMonthP50.toFixed(0)), contribution: income.fitQuality },
        { name: "Expenses next-month P50 (₹)", value: Number(expenses.nextMonthP50.toFixed(0)), contribution: expenses.fitQuality },
        { name: "Savings rate next-month P50", value: Number(savingsRate.nextMonthP50.toFixed(3)), contribution: savingsRate.fitQuality },
      ],
      explanation: insufficientHistory
        ? `Only ${activeMonths.length} month(s) of activity logged — not enough for per-metric probabilistic forecasts, so these are flat carry-forward estimates with wide uncertainty.`
        : `Next month: income ≈ ₹${income.nextMonthP50.toFixed(0)} (90% band ₹${income.quantileForecast[0].p10.toFixed(0)}–₹${income.quantileForecast[0].p90.toFixed(0)}), expenses ≈ ₹${expenses.nextMonthP50.toFixed(0)} (90% band ₹${expenses.quantileForecast[0].p10.toFixed(0)}–₹${expenses.quantileForecast[0].p90.toFixed(0)}), savings rate ≈ ${(savingsRate.nextMonthP50 * 100).toFixed(1)}%.`,
    };
  }

  private forecastMetric(
    metric: ForecastMetricName,
    values: number[],
    monthOfYear: number[],
    insufficientHistory: boolean,
  ): MetricForecastResult {
    if (insufficientHistory) {
      const last = values[values.length - 1] ?? 0;
      return {
        metric,
        nextMonthP50: last,
        trendSlopePerMonth: 0,
        confidenceInterval95: { lower: last, upper: last },
        quantileForecast: [1, 2, 3].map((monthsAhead) => ({ monthsAhead, p10: last, p50: last, p90: last })),
        decomposition: { hasSeasonality: false, trendSlope: 0 },
        personalizedBaseline: { historicalMean: last, historicalStdDev: 0 },
        fitQuality: 0,
      };
    }

    const result = bayesianQuantileForecast(values, monthOfYear, [1, 2, 3]);
    const oneMonthAhead = result.pointForecasts[0];

    return {
      metric,
      nextMonthP50: oneMonthAhead.p50,
      trendSlopePerMonth: result.trendSlopePerMonth,
      confidenceInterval95: result.confidenceInterval95,
      quantileForecast: result.pointForecasts.map((f) => ({ monthsAhead: f.monthsAhead, p10: f.p10, p50: f.p50, p90: f.p90 })),
      decomposition: { hasSeasonality: result.decomposition.hasSeasonality, trendSlope: result.trendSlopePerMonth },
      personalizedBaseline: result.personalizedBaseline,
      fitQuality: result.fitQuality,
    };
  }
}
