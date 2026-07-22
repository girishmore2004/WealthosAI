import { Injectable } from "@nestjs/common";
import { GoalDTO } from "@wealthos/types";
import { logistic, clamp01 } from "../ml-insights.math";
import { ModelOutput } from "../model-output.types";

export interface GoalSuccessPrediction {
  goalId: string;
  goalName: string;
  successProbability: number; // 0-1
}

// requiredMonthlyContribution (computed elsewhere, in GoalsService) is already
// derived from exactly the two things that matter — how much is left to save and how
// long there is to save it — so "committed contribution ÷ required contribution" is a
// single, complete, honest feature: a ratio of 1.0 means "on pace exactly", not an
// approximation missing some other factor. This model's only job is turning that
// unbounded ratio into a calibrated-feeling bounded probability via the logistic
// function, which is a real, standard technique — applied here to a hand-specified
// score (the ratio) rather than one fitted by regression against real outcomes, since
// this app has no historical "did the user actually hit their goal" labels to fit
// against. That distinction is stated here rather than left implicit.
const STEEPNESS = 3; // controls how sharply probability drops off as the ratio moves away from 1.0

@Injectable()
export class GoalSuccessModel {
  score(goals: GoalDTO[]): ModelOutput<GoalSuccessPrediction[]> {
    const predictions = goals.map((g) => {
      const committed = Number(g.monthlyContribution);
      const required = g.requiredMonthlyContribution;
      // required <= 0 means the goal is already fully funded (nothing more needed) —
      // treat as certain success rather than dividing by zero.
      const ratio = required <= 0 ? 2 : committed / required;
      const successProbability = clamp01(logistic(ratio - 1, STEEPNESS));
      return { goalId: g.id, goalName: g.name, successProbability, ratio };
    });

    const atRisk = predictions.filter((p) => p.successProbability < 0.5);

    return {
      method: "Logistic function over committed-vs-required monthly contribution ratio (hand-specified score, not fitted to historical outcomes)",
      prediction: predictions.map(({ ratio, ...p }) => p),
      confidence: goals.length > 0 ? 1 : 0, // deterministic given the inputs; 0 confidence only means "no goals to score", not model uncertainty
      contributingFeatures: predictions.map((p) => ({ name: p.goalName, value: Number(p.ratio.toFixed(2)), contribution: p.successProbability })),
      explanation:
        atRisk.length === 0
          ? goals.length === 0
            ? "No goals set yet."
            : `All ${goals.length} goal(s) have a success probability at or above 50% given their current committed contributions.`
          : `${atRisk.length} of ${goals.length} goal(s) have a success probability below 50%: ${atRisk.map((p) => `"${p.goalName}" (${Math.round(p.successProbability * 100)}%)`).join(", ")}.`,
    };
  }
}
