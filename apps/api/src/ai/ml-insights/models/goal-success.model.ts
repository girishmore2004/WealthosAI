import { Injectable } from "@nestjs/common";
import { GoalDTO } from "@wealthos/types";
import { logistic, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface GoalSuccessPrediction {
  goalId: string;
  goalName: string;
  successProbability: number; // 0-1
  /** GoalsService's own threshold-based tier (ON_TRACK/AT_RISK/OFF_TRACK), carried
   * through unchanged rather than re-derived, so a consumer of this model's output can
   * see both signals side by side instead of the two silently disagreeing in two
   * different UI locations (the exact risk the audit flagged for this model). */
  ruleBasedTier: GoalDTO["probabilityOfSuccess"];
  /** True when this model's own >=50%/<50% call points the same direction as
   * ruleBasedTier (ON_TRACK or AT_RISK both read as "on pace" here; only OFF_TRACK
   * reads as "not on pace" — AT_RISK is deliberately treated as agreeing with a >=50%
   * statistical read since it is GoalsService's own middle tier, not its failure
   * tier). Turns a possible silent inconsistency into an explicit, checkable fact
   * instead of leaving it for someone to notice by comparing two screens. */
  agreesWithRuleBasedTier: boolean;
}

// requiredMonthlyContribution and contributionPaceRatio are both computed once, in
// GoalsService — the same growth-aware projection (assumedAnnualReturnPercent
// compounded to the target date) that produces requiredMonthlyContribution also
// produces contributionPaceRatio (monthlyContribution ÷ requiredMonthlyContribution,
// with the required<=0 "already fully funded going forward" case already handled
// there as ratio = 1). This model previously re-derived that same ratio from raw
// committed/required fields with its own, slightly different required<=0 handling
// (ratio = 2) — two independent implementations of the identical formula are exactly
// how these numbers quietly drift apart over time. There is now exactly one place
// that computes this ratio; this model only turns it into a bounded probability via
// the logistic function, a real, standard technique — applied here to a
// hand-specified score (the ratio) rather than one fitted by regression against real
// outcomes, since this app has no historical "did the user actually hit their goal"
// labels to fit against. That distinction is stated here rather than left implicit.
const STEEPNESS = 3; // controls how sharply probability drops off as the ratio moves away from 1.0

@Injectable()
export class GoalSuccessModel {
  score(goals: GoalDTO[]): ModelOutput<GoalSuccessPrediction[]> {
    const predictions = goals.map((g) => {
      const ratio = g.contributionPaceRatio;
      // progressPercent >= 100 means the goal is already fully funded TODAY (today's
      // currentAmount + linkedInvestmentValue already covers targetAmount) — the exact
      // same "remaining === 0" current-state fact GoalsService uses for its own
      // ON_TRACK short-circuit, which is a stronger and more certain signal than the
      // forward-looking pace ratio alone. Mirroring that short-circuit here matters
      // because contributionPaceRatio is defined as 1 (not some larger "certain"
      // value) whenever requiredMonthlyContribution <= 0, and logistic(1 - 1) = 0.5 —
      // without this, an already-fully-funded goal would show only 50% probability,
      // understating a fact that is not actually in doubt.
      const alreadyFundedToday = g.progressPercent >= 100;
      const successProbability = alreadyFundedToday ? 1 : clamp01(logistic(ratio - 1, STEEPNESS));

      const ruleBasedTier = g.probabilityOfSuccess;
      const modelSaysOnPace = successProbability >= 0.5;
      const ruleSaysOnPace = ruleBasedTier !== "OFF_TRACK"; // ON_TRACK or AT_RISK both read as "on pace" per GoalsService's own tiering
      const agreesWithRuleBasedTier = modelSaysOnPace === ruleSaysOnPace;

      return { goalId: g.id, goalName: g.name, successProbability, ratio, ruleBasedTier, agreesWithRuleBasedTier };
    });

    const atRisk = predictions.filter((p) => p.successProbability < 0.5);
    const disagreements = predictions.filter((p) => !p.agreesWithRuleBasedTier);

    return {
      method:
        "Logistic function over GoalsService's own growth-aware committed-vs-required contribution pace ratio (hand-specified score, not fitted to historical outcomes)",
      prediction: predictions.map(({ ratio, ...p }) => p),
      confidence: goals.length > 0 ? 1 : 0, // deterministic given the inputs; 0 confidence only means "no goals to score", not model uncertainty
      contributingFeatures: predictions.map((p) => ({ name: p.goalName, value: Number(p.ratio.toFixed(2)), contribution: p.successProbability })),
      explanation:
        goals.length === 0
          ? "No goals set yet."
          : `${atRisk.length === 0 ? `All ${goals.length} goal(s) have a success probability at or above 50%` : `${atRisk.length} of ${goals.length} goal(s) have a success probability below 50%: ${atRisk
              .map((p) => `"${p.goalName}" (${Math.round(p.successProbability * 100)}%)`)
              .join(", ")}`} given their current committed contributions.${
              disagreements.length === 0
                ? ""
                : ` Note: ${disagreements.length} goal(s) show a different read here than on the Goals page (${disagreements
                    .map((p) => `"${p.goalName}"`)
                    .join(", ")}) — worth a closer look.`
            }`,
    };
  }
}
