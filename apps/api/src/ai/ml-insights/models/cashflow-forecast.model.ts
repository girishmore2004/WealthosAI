import { Injectable } from "@nestjs/common";
import { MonthlyPoint } from "../features/feature-extraction.service";
import { linearRegression, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface CashflowForecast {
  nextMonthProjectedCashflow: number;
  trendSlopePerMonth: number;
  stressRisk: boolean; // projected cashflow turns (or stays) negative
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
        method: "Ordinary least-squares linear regression on trailing monthly net cashflow",
        prediction: { nextMonthProjectedCashflow: lastKnown, trendSlopePerMonth: 0, stressRisk: lastKnown < 0 },
        confidence: 0.2, // too little history for a real trend — this is closer to "last month repeated" than a forecast
        contributingFeatures: [{ name: "months of history available", value: activeMonths.length, contribution: 0 }],
        explanation: `Only ${activeMonths.length} month(s) of activity logged — not enough for a real trend, so this just repeats the most recent month's cashflow (₹${lastKnown.toFixed(0)}).`,
      };
    }

    const points = activeMonths.map((m, i) => ({ x: i, y: m.netCashflow }));
    const regression = linearRegression(points);
    const nextX = points.length; // one step past the last observed month
    const projected = regression.predict(nextX);

    return {
      method: "Ordinary least-squares linear regression on trailing monthly net cashflow",
      prediction: { nextMonthProjectedCashflow: projected, trendSlopePerMonth: regression.slope, stressRisk: projected < 0 },
      confidence: clamp01(regression.rSquared), // R² — how well a straight line actually explains the recent months
      contributingFeatures: [
        { name: "trend slope (₹/month)", value: regression.slope, contribution: regression.slope },
        { name: "fit quality (R²)", value: regression.rSquared, contribution: regression.rSquared },
      ],
      explanation:
        projected < 0
          ? `Based on the last ${activeMonths.length} months' trend, next month's cashflow is projected to go negative (₹${projected.toFixed(0)}) — the recent monthly trend is ${regression.slope >= 0 ? "improving" : "worsening"} by about ₹${Math.abs(regression.slope).toFixed(0)}/month, but not enough to avoid this.`
          : `Based on the last ${activeMonths.length} months' trend, next month's cashflow is projected at roughly ₹${projected.toFixed(0)}, ${regression.slope >= 0 ? "trending up" : "trending down"} by about ₹${Math.abs(regression.slope).toFixed(0)}/month.`,
    };
  }
}
