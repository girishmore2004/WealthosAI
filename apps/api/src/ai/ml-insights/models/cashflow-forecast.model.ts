import { Injectable } from "@nestjs/common";
import { MonthlyPoint } from "../features/feature-extraction.service";
import { bayesianQuantileForecast, clamp01, DecompositionResult } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface QuantileForecastPoint {
  monthsAhead: number;
  p10: number;
  p50: number;
  p90: number;
}

export interface CashflowForecast {
  // --- Kept exactly as before (field names/semantics unchanged) so every existing
  // consumer — the Dashboard panel, MlInsightsService's own history logging — keeps
  // reading the same numbers it always has. nextMonthProjectedCashflow is now the
  // Bayesian-shrunk 1-month-ahead point forecast (see method note below) rather than
  // a raw OLS extrapolation, which in practice makes it MORE stable/consistent
  // (regresses toward the user's own long-run baseline instead of chasing a noisy
  // recent trend), not less.
  nextMonthProjectedCashflow: number;
  trendSlopePerMonth: number;
  stressRisk: boolean;

  // --- NEW: advanced probabilistic outputs -----------------------------------------
  /** 95% confidence interval around nextMonthProjectedCashflow. */
  confidenceInterval95: { lower: number; upper: number };
  /** P10/P50/P90 projected net cashflow, 1/2/3 months ahead. */
  quantileForecast: QuantileForecastPoint[];
  /** Trend/seasonal/residual decomposition of the historical series itself (not the
   * forecast) — see ml-insights.math.ts#classicalDecomposition for the seasonality
   * caveat (hasSeasonality is false, and seasonalAdjustmentThisMonth is 0, unless
   * there are 24+ months of history). */
  decomposition: { hasSeasonality: boolean; seasonalAdjustmentThisMonth: number; residualStdDev: number };
  /** This user's own long-run mean/stdDev — the Bayesian prior driving the shrinkage
   * above, surfaced directly so the UI can show "vs. your own typical" rather than
   * only the forecast number in isolation. */
  personalizedBaseline: { historicalMean: number; historicalStdDev: number };
}

const MIN_MONTHS_FOR_TREND = 4;

@Injectable()
export class CashflowForecastModel {
  forecast(monthlySeries: MonthlyPoint[]): ModelOutput<CashflowForecast> {
    // Only count months with any recorded activity — an all-zero month (before the
    // user started logging) would otherwise drag the trend line toward zero for no
    // real reason.
    const activeMonths = monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0);

    if (activeMonths.length < MIN_MONTHS_FOR_TREND) {
      const lastKnown = activeMonths[activeMonths.length - 1]?.netCashflow ?? 0;
      return {
        method: "Bayesian-shrunk OLS trend forecast on trailing monthly net cashflow, with quantile/CI outputs (falls back to last-known value below the minimum history threshold)",
        prediction: {
          nextMonthProjectedCashflow: lastKnown,
          trendSlopePerMonth: 0,
          stressRisk: lastKnown < 0,
          confidenceInterval95: { lower: lastKnown, upper: lastKnown },
          quantileForecast: [1, 2, 3].map((monthsAhead) => ({ monthsAhead, p10: lastKnown, p50: lastKnown, p90: lastKnown })),
          decomposition: { hasSeasonality: false, seasonalAdjustmentThisMonth: 0, residualStdDev: 0 },
          personalizedBaseline: { historicalMean: lastKnown, historicalStdDev: 0 },
        },
        confidence: 0.2, // too little history for a real trend — this is closer to "last month repeated" than a forecast
        contributingFeatures: [{ name: "months of history available", value: activeMonths.length, contribution: 0 }],
        explanation: `Only ${activeMonths.length} month(s) of activity logged — not enough for a real trend, so this just repeats the most recent month's cashflow (₹${lastKnown.toFixed(0)}) with no meaningful uncertainty band.`,
      };
    }

    const values = activeMonths.map((m) => m.netCashflow);
    const monthOfYear = activeMonths.map((m) => Number(m.month.slice(5, 7)) - 1);
    const result = bayesianQuantileForecast(values, monthOfYear, [1, 2, 3]);
    const oneMonthAhead = result.pointForecasts[0];

    const quantileForecast: QuantileForecastPoint[] = result.pointForecasts.map((f) => ({
      monthsAhead: f.monthsAhead,
      p10: f.p10,
      p50: f.p50,
      p90: f.p90,
    }));

    const decomposition = this.summarizeDecomposition(result.decomposition);

    return {
      method:
        "Bayesian-shrunk OLS trend forecast (personal long-run mean as prior, OLS trend extrapolation weighted by fit quality as evidence) on trailing monthly net cashflow, with P10/P50/P90 quantiles and a 95% confidence interval",
      prediction: {
        nextMonthProjectedCashflow: oneMonthAhead.mean,
        trendSlopePerMonth: result.trendSlopePerMonth,
        stressRisk: oneMonthAhead.mean < 0,
        confidenceInterval95: result.confidenceInterval95,
        quantileForecast,
        decomposition,
        personalizedBaseline: result.personalizedBaseline,
      },
      confidence: clamp01(result.fitQuality), // R² of the underlying trend — how well a straight line actually explains the recent months
      contributingFeatures: [
        { name: "trend slope (₹/month)", value: result.trendSlopePerMonth, contribution: result.trendSlopePerMonth },
        { name: "fit quality (R²)", value: result.fitQuality, contribution: result.fitQuality },
        { name: "personal baseline mean (₹/month)", value: result.personalizedBaseline.historicalMean, contribution: 0 },
      ],
      explanation:
        oneMonthAhead.mean < 0
          ? `Based on your own history and recent trend, next month's cashflow is projected to go negative (₹${oneMonthAhead.mean.toFixed(0)}, 95% CI ₹${result.confidenceInterval95.lower.toFixed(0)} to ₹${result.confidenceInterval95.upper.toFixed(0)}) — the recent trend is ${result.trendSlopePerMonth >= 0 ? "improving" : "worsening"} by about ₹${Math.abs(result.trendSlopePerMonth).toFixed(0)}/month, but not enough to avoid this.`
          : `Based on your own history and recent trend, next month's cashflow is projected at roughly ₹${oneMonthAhead.mean.toFixed(0)} (95% CI ₹${result.confidenceInterval95.lower.toFixed(0)} to ₹${result.confidenceInterval95.upper.toFixed(0)}), ${result.trendSlopePerMonth >= 0 ? "trending up" : "trending down"} by about ₹${Math.abs(result.trendSlopePerMonth).toFixed(0)}/month.`,
    };
  }

  private summarizeDecomposition(decomposition: DecompositionResult): CashflowForecast["decomposition"] {
    const residualStdDev =
      decomposition.residual.length < 2
        ? 0
        : Math.sqrt(
            decomposition.residual.reduce((s, r) => s + r ** 2, 0) / Math.max(1, decomposition.residual.length - 1),
          );
    return {
      hasSeasonality: decomposition.hasSeasonality,
      seasonalAdjustmentThisMonth: decomposition.hasSeasonality ? decomposition.seasonal[decomposition.seasonal.length - 1] ?? 0 : 0,
      residualStdDev,
    };
  }
}
