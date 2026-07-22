import { Injectable } from "@nestjs/common";
import { MonthlyPoint } from "../features/feature-extraction.service";
import { mean, stdDev, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export type BehavioralState = "high_saving" | "balanced" | "overspending";

export interface MonthSegment {
  month: string;
  savingsRate: number;
  zScoreVsOwnHistory: number;
  state: BehavioralState;
}

const MIN_MONTHS = 4;

// "Habit segmentation" here means segmenting THIS user's own months into behavioral
// states relative to their own history — not clustering across a population of users,
// which this single-tenant-per-request app has no cross-user cohort data to support
// (and pretending otherwise would be exactly the kind of unlabeled "AI" this roadmap
// explicitly asked not to ship). Each month's savings rate is scored against the
// user's own trailing mean/stdev — a real z-score, not an arbitrary bucket.
@Injectable()
export class HabitSegmentationModel {
  segment(monthlySeries: MonthlyPoint[]): ModelOutput<MonthSegment[]> {
    const activeMonths = monthlySeries.filter((m) => m.totalIncome !== 0 || m.totalExpenses !== 0);

    if (activeMonths.length < MIN_MONTHS) {
      return {
        method: "Per-user z-score of monthly savings rate against the user's own trailing history",
        prediction: [],
        confidence: 0,
        contributingFeatures: [],
        explanation: `Need at least ${MIN_MONTHS} months of activity to establish a personal baseline — only ${activeMonths.length} available.`,
      };
    }

    const rates = activeMonths.map((m) => m.savingsRate);
    const m = mean(rates);
    const sd = stdDev(rates);

    const segments: MonthSegment[] = activeMonths.map((point) => {
      const z = sd === 0 ? 0 : (point.savingsRate - m) / sd;
      const state: BehavioralState = z >= 1 ? "high_saving" : z <= -1 ? "overspending" : "balanced";
      return { month: point.month, savingsRate: point.savingsRate, zScoreVsOwnHistory: Number(z.toFixed(2)), state };
    });

    const stateCounts = segments.reduce<Record<BehavioralState, number>>(
      (acc, s) => ({ ...acc, [s.state]: acc[s.state] + 1 }),
      { high_saving: 0, balanced: 0, overspending: 0 },
    );

    const mostRecent = segments[segments.length - 1];

    return {
      method: "Per-user z-score of monthly savings rate against the user's own trailing history",
      prediction: segments,
      confidence: clamp01(activeMonths.length / 12), // more months of personal history = a more trustworthy personal baseline
      contributingFeatures: [
        { name: "Months classified high-saving", value: stateCounts.high_saving, contribution: stateCounts.high_saving / segments.length },
        { name: "Months classified balanced", value: stateCounts.balanced, contribution: stateCounts.balanced / segments.length },
        { name: "Months classified overspending", value: stateCounts.overspending, contribution: stateCounts.overspending / segments.length },
      ],
      explanation: `Most recent month (${mostRecent.month}) is classified "${mostRecent.state.replace("_", " ")}" relative to your own history (z = ${mostRecent.zScoreVsOwnHistory}). Over the last ${segments.length} months: ${stateCounts.high_saving} high-saving, ${stateCounts.balanced} balanced, ${stateCounts.overspending} overspending.`,
    };
  }
}
