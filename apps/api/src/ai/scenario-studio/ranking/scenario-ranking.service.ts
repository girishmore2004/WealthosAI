import { Injectable } from "@nestjs/common";
import { GoalsService } from "../../../goals/goals.service";
import { ScenarioVariant } from "../expansion/scenario-expander.service";

export interface GoalImpactNote {
  goalId: string;
  goalName: string;
  requiredMonthlyContribution: number;
  helped: boolean;
  note: string;
}

export interface RankedVariant {
  label: ScenarioVariant["label"];
  score: number;
  netWorthDeltaIn5Years: number;
  feasible: boolean;
  feasibilityNote: string;
  goalImpacts: GoalImpactNote[];
}

// An infeasible variant is never allowed to outrank a feasible one, however good its
// raw number looks — a "best case" that assumes committing money the user doesn't
// have isn't actually the best case to present first. This constant is large enough
// that no realistic netWorthDeltaIn5Years value would let an infeasible variant win.
const INFEASIBILITY_PENALTY = 1e12;

@Injectable()
export class ScenarioRankingService {
  constructor(private goals: GoalsService) {}

  async rank(userId: string, variants: ScenarioVariant[], targetGoalIds: string[] = []): Promise<RankedVariant[]> {
    const goals = targetGoalIds.length > 0 ? await this.goals.list(userId) : [];
    const targetGoals = goals.filter((g) => targetGoalIds.includes(g.id));

    const ranked = variants.map((variant) => {
      const netWorthDelta = Number(variant.run.result.netWorthDeltaIn5Years);
      const monthlyCashflowDelta = Number(variant.run.result.monthlyCashflowDelta);
      const score = netWorthDelta - (variant.feasible ? 0 : INFEASIBILITY_PENALTY);

      const goalImpacts: GoalImpactNote[] = targetGoals.map((goal) => {
        const requiredMonthlyContribution = goal.requiredMonthlyContribution;
        // A simple, honest read: does this variant's monthly cashflow change cover
        // (or worsen) the gap between what the goal needs and what's already
        // committed to it — not a full re-simulation of the goal's own trajectory
        // under this scenario, which the underlying engine doesn't model.
        const helped = monthlyCashflowDelta >= 0;
        return {
          goalId: goal.id,
          goalName: goal.name,
          requiredMonthlyContribution,
          helped,
          note: helped
            ? `This variant's monthly cashflow improves by ₹${monthlyCashflowDelta.toFixed(0)}, which could help fund "${goal.name}" (needs ₹${requiredMonthlyContribution.toFixed(0)}/month).`
            : `This variant's monthly cashflow worsens by ₹${Math.abs(monthlyCashflowDelta).toFixed(0)}, which would make it harder to fund "${goal.name}" (needs ₹${requiredMonthlyContribution.toFixed(0)}/month).`,
        };
      });

      return {
        label: variant.label,
        score,
        netWorthDeltaIn5Years: netWorthDelta,
        feasible: variant.feasible,
        feasibilityNote: variant.feasibilityNote,
        goalImpacts,
      };
    });

    return ranked.sort((a, b) => b.score - a.score);
  }
}
