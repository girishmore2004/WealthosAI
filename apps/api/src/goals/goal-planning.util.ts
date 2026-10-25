// PURE — the Goals overview's planning arithmetic (progress, shortfall, required monthly contribution, the
// on-track read), lifted out of GoalsService so that Money → Goals and the Goals overview are computed by
// the SAME function from the SAME facts and can never show two different answers for one goal.
//
// The maths is GoalsService.enrich() as it was, with two deliberate changes:
//   * "months remaining" now uses the shared periodsUntil() (whole UTC days / 30.4375, rounded up) — the
//     function the emergency-fund plan already used — instead of a second, slightly different month count;
//   * a goal with no deadline (Goal.deadlineSet = false) has no pace to judge, so nothing is "required".
// Feasibility stays an explainable pace heuristic (contribution vs required), never a modelled probability.

import type { GoalDTO, GoalFundBacking } from "@wealthos/types";
import { periodsUntil } from "../common/financial-facts/financial-formulas";

export const DAYS_PER_MONTH = 30.4375;

export interface GoalPlanningInput {
  id: string;
  userId: string;
  type: string;
  name: string;
  targetAmount: unknown;
  targetDate: Date;
  // Cash set aside (the ledger balance) — NOT planned contributions.
  currentAmount: unknown;
  monthlyContribution: unknown;
  assumedAnnualReturnPercent: unknown;
  investments: { currentValue: unknown }[];
  deadlineSet?: boolean;
  archivedAt?: Date | null;
}

export function enrichGoal(goal: GoalPlanningInput, backing: GoalFundBacking, now: Date = new Date()): GoalDTO {
  const targetAmount = Number(goal.targetAmount);
  const currentAmount = Number(goal.currentAmount);
  const monthlyContribution = Number(goal.monthlyContribution);
  const linkedInvestmentValue = goal.investments.reduce((sum, i) => sum + Number(i.currentValue), 0);
  const hasTargetDate = goal.deadlineSet !== false;

  const totalSaved = currentAmount + linkedInvestmentValue;
  const monthsRemaining = Math.max(1, periodsUntil(goal.targetDate, now, DAYS_PER_MONTH));
  // Today's actual shortfall — used for the "already fully funded right now" check and progressPercent.
  // Never growth-projected, and never negative: a fully funded goal has a shortfall of exactly zero.
  const remaining = Math.max(0, targetAmount - totalSaved);
  const progressPercent = targetAmount > 0 ? Number(Math.min(100, (totalSaved / targetAmount) * 100).toFixed(1)) : 0;

  const assumedAnnualReturn = Number(goal.assumedAnnualReturnPercent ?? 0) / 100;
  const monthlyReturn = assumedAnnualReturn / 12;
  const projectedInvestmentValueAtTarget =
    Math.abs(monthlyReturn) < 0.0001 ? linkedInvestmentValue : linkedInvestmentValue * Math.pow(1 + monthlyReturn, monthsRemaining);

  const remainingForRequiredCalc = Math.max(0, targetAmount - currentAmount - projectedInvestmentValueAtTarget);
  const requiredMonthlyContribution = hasTargetDate ? Number((remainingForRequiredCalc / monthsRemaining).toFixed(2)) : 0;

  let probabilityOfSuccess: GoalDTO["probabilityOfSuccess"] = "OFF_TRACK";
  if (!hasTargetDate) {
    // No deadline = no pace to compare. Funded, or putting money in regularly, reads as on track.
    probabilityOfSuccess = remaining === 0 || monthlyContribution > 0 ? "ON_TRACK" : "AT_RISK";
  } else if (remaining === 0 || monthlyContribution >= requiredMonthlyContribution * 0.95) {
    probabilityOfSuccess = "ON_TRACK";
  } else if (monthlyContribution >= requiredMonthlyContribution * 0.6) {
    probabilityOfSuccess = "AT_RISK";
  }

  // Uncapped by design — a genuinely honest ratio, not a bucketed label. 1 whenever no further
  // contribution is actually required.
  const contributionPaceRatio = requiredMonthlyContribution > 0 ? Number((monthlyContribution / requiredMonthlyContribution).toFixed(3)) : 1;

  return {
    id: goal.id,
    userId: goal.userId,
    type: goal.type as GoalDTO["type"],
    name: goal.name,
    targetAmount: targetAmount.toFixed(2),
    targetDate: goal.targetDate.toISOString(),
    currentAmount: currentAmount.toFixed(2),
    monthlyContribution: monthlyContribution.toFixed(2),
    linkedInvestmentValue: linkedInvestmentValue.toFixed(2),
    requiredMonthlyContribution,
    progressPercent,
    probabilityOfSuccess,
    contributionPaceRatio,
    isPaceHeuristic: true,
    projectedInvestmentValueAtTarget: projectedInvestmentValueAtTarget.toFixed(2),
    assumedAnnualReturnPercent: (assumedAnnualReturn * 100).toFixed(2),
    shortfall: remaining.toFixed(2),
    hasTargetDate,
    archivedAt: goal.archivedAt ? goal.archivedAt.toISOString() : null,
    fundingBacking: backing,
  };
}
