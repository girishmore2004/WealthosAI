import { Injectable } from "@nestjs/common";
import { ModelOutput } from "../model-output.types";
import { clamp01 } from "../ml-insights.math";

export interface DebtRiskInput {
  totalOutstanding: number;
  totalMonthlyEmi: number;
  monthlyIncome: number;
  loans: { outstandingPrincipal: number; interestRateAnnual: number }[];
}

export interface DebtRiskPrediction {
  riskScore: number; // 0-100
  tier: "low" | "moderate" | "high" | "severe";
}

// Hand-specified weights, not fitted to data — this app has no labeled "did this user
// actually default" outcome to train a real classifier against, so pretending these
// weights were learned would be dishonest. What's real here is the scorecard
// *structure* (the same normalize-each-factor-then-weighted-sum approach real credit
// scorecards use) and the fact that every number a user sees traces to one of these
// three named, inspectable factors — not an opaque single score.
const WEIGHTS = { emiToIncome: 0.5, debtToIncome: 0.3, avgInterestRate: 0.2 };

// Normalization caps — the input value at which a factor is considered "maximally
// risky" (clamped to 1.0 beyond this). Documented so the caps themselves are
// reviewable/tunable, not buried magic numbers.
const CAPS = {
  emiToIncomeRatio: 0.5, // 50% of monthly income going to EMIs
  debtToIncomeRatio: 5, // total debt at 5x annual income
  interestRateFloor: 6, // rates at/below this contribute ~0 risk (roughly a cheap secured loan rate)
  interestRateCeiling: 20, // rates at/above this are maximally risky (roughly unsecured/credit-card territory)
};

@Injectable()
export class DebtRiskModel {
  score(input: DebtRiskInput): ModelOutput<DebtRiskPrediction> {
    if (input.loans.length === 0) {
      return {
        method: "Weighted scorecard: EMI-to-income, debt-to-income, average interest rate (hand-specified weights, not trained)",
        prediction: { riskScore: 0, tier: "low" },
        confidence: 1, // no debt is a certain fact, not a modeled estimate
        contributingFeatures: [],
        explanation: "No loans on file — there is no debt risk to assess.",
      };
    }

    const emiToIncomeRatio = input.monthlyIncome > 0 ? input.totalMonthlyEmi / input.monthlyIncome : 1;
    const debtToIncomeRatio = input.monthlyIncome > 0 ? input.totalOutstanding / (input.monthlyIncome * 12) : CAPS.debtToIncomeRatio;

    const totalPrincipal = input.loans.reduce((s, l) => s + l.outstandingPrincipal, 0);
    const avgInterestRate =
      totalPrincipal > 0
        ? input.loans.reduce((s, l) => s + l.interestRateAnnual * l.outstandingPrincipal, 0) / totalPrincipal
        : 0;

    const emiFactor = clamp01(emiToIncomeRatio / CAPS.emiToIncomeRatio);
    const debtFactor = clamp01(debtToIncomeRatio / CAPS.debtToIncomeRatio);
    const rateFactor = clamp01((avgInterestRate - CAPS.interestRateFloor) / (CAPS.interestRateCeiling - CAPS.interestRateFloor));

    const weightedScore = emiFactor * WEIGHTS.emiToIncome + debtFactor * WEIGHTS.debtToIncome + rateFactor * WEIGHTS.avgInterestRate;
    const riskScore = Math.round(weightedScore * 100);
    const tier = riskScore >= 75 ? "severe" : riskScore >= 50 ? "high" : riskScore >= 25 ? "moderate" : "low";

    const contributingFeatures = [
      { name: "EMI-to-income ratio", value: Number(emiToIncomeRatio.toFixed(3)), contribution: Number((emiFactor * WEIGHTS.emiToIncome).toFixed(3)) },
      { name: "Debt-to-annual-income ratio", value: Number(debtToIncomeRatio.toFixed(3)), contribution: Number((debtFactor * WEIGHTS.debtToIncome).toFixed(3)) },
      { name: "Weighted average interest rate (%)", value: Number(avgInterestRate.toFixed(2)), contribution: Number((rateFactor * WEIGHTS.avgInterestRate).toFixed(3)) },
    ].sort((a, b) => b.contribution - a.contribution);

    return {
      method: "Weighted scorecard: EMI-to-income, debt-to-income, average interest rate (hand-specified weights, not trained)",
      prediction: { riskScore, tier },
      confidence: 1, // deterministic given the inputs — the uncertainty here is in the scorecard design, not in this specific computation
      contributingFeatures,
      explanation: `Debt risk score ${riskScore}/100 (${tier}) — driven mainly by ${contributingFeatures[0].name.toLowerCase()} (${contributingFeatures[0].value}).`,
    };
  }
}
