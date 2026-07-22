import { Injectable } from "@nestjs/common";
import { MonthlyPoint } from "../features/feature-extraction.service";
import { twoWindowZTest, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface DriftPrediction {
  drifted: boolean;
  direction: "improving" | "worsening" | "none";
  recentWindowMeanSavingsRate: number;
  priorWindowMeanSavingsRate: number;
  zStatistic: number;
}

const WINDOW_SIZE = 3; // months per window — recent quarter vs. the quarter before it
const SIGNIFICANCE_Z = 1.96; // ~95% confidence under a normal approximation — the standard two-tailed cutoff

@Injectable()
export class DriftDetectionModel {
  detect(monthlySeries: MonthlyPoint[]): ModelOutput<DriftPrediction> {
    const activeMonths = monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0);

    if (activeMonths.length < WINDOW_SIZE * 2) {
      return {
        method: "Two-window (Welch's) z-test on monthly savings rate",
        prediction: { drifted: false, direction: "none", recentWindowMeanSavingsRate: 0, priorWindowMeanSavingsRate: 0, zStatistic: 0 },
        confidence: 0,
        contributingFeatures: [],
        explanation: `Need at least ${WINDOW_SIZE * 2} months of activity to compare a recent window against a prior one — only ${activeMonths.length} available.`,
      };
    }

    const recentWindow = activeMonths.slice(-WINDOW_SIZE).map((m) => m.savingsRate);
    const priorWindow = activeMonths.slice(-WINDOW_SIZE * 2, -WINDOW_SIZE).map((m) => m.savingsRate);

    const { z, meanA, meanB } = twoWindowZTest(priorWindow, recentWindow);
    const drifted = Math.abs(z) >= SIGNIFICANCE_Z;
    const direction: DriftPrediction["direction"] = !drifted ? "none" : z > 0 ? "improving" : "worsening";

    return {
      method: "Two-window (Welch's) z-test on monthly savings rate",
      prediction: { drifted, direction, recentWindowMeanSavingsRate: meanB, priorWindowMeanSavingsRate: meanA, zStatistic: Number(z.toFixed(2)) },
      // Confidence scales with how far past the significance threshold the statistic
      // is, capped at 1 — a z right at 1.96 is barely significant, a z of 4 is a lot
      // more certain, and that difference is worth surfacing rather than collapsing
      // both into a flat "drifted: true".
      confidence: clamp01(Math.abs(z) / (SIGNIFICANCE_Z * 2)),
      contributingFeatures: [
        { name: `Prior ${WINDOW_SIZE}-month avg savings rate`, value: Number((meanA * 100).toFixed(1)), contribution: 0.5 },
        { name: `Recent ${WINDOW_SIZE}-month avg savings rate`, value: Number((meanB * 100).toFixed(1)), contribution: 0.5 },
      ],
      explanation: !drifted
        ? `No statistically significant change in savings rate between the prior ${WINDOW_SIZE} months (avg ${(meanA * 100).toFixed(1)}%) and the recent ${WINDOW_SIZE} months (avg ${(meanB * 100).toFixed(1)}%).`
        : `Savings rate has ${direction === "improving" ? "significantly improved" : "significantly worsened"} — from an average of ${(meanA * 100).toFixed(1)}% to ${(meanB * 100).toFixed(1)}% (z = ${z.toFixed(2)}).`,
    };
  }
}
