import { Injectable } from "@nestjs/common";
import { SimulatorService } from "../../../simulator/simulator.service";
import { LoansService } from "../../../loans/loans.service";
import { InvestmentsService } from "../../../investments/investments.service";
import { calculateEmi } from "../../../simulator/simulator.engine";
import { RunScenarioResponseDTO, ScenarioType } from "@wealthos/types";
import {
  AGE_SENSITIVITY_DELTAS,
  MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS,
  SCENARIO_FIELD_CONFIG,
  VARIANT_LABELS,
  VARIANT_MULTIPLIERS,
  VariantLabel,
} from "../scenario-studio.constants";
import { computeMonthlySurplus, maxAffordablePrincipal } from "../affordability.util";

export interface ScenarioVariant {
  label: VariantLabel;
  params: Record<string, unknown>;
  run: RunScenarioResponseDTO;
  feasible: boolean;
  feasibilityNote: string;
}

@Injectable()
export class ScenarioExpanderService {
  constructor(
    private simulator: SimulatorService,
    private loans: LoansService,
    private investments: InvestmentsService,
  ) {}

  async expand(userId: string, scenarioType: ScenarioType, baseParams: Record<string, unknown>): Promise<ScenarioVariant[]> {
    // Establishes the real baseline (income, expenses, investments, debt) once, from
    // the user's literal input — every variant reuses this same baseline rather than
    // each variant re-deriving it, so all four are directly comparable against the
    // same starting point.
    const [baseRun, debtSummary, liquidInvestmentsValue] = await Promise.all([
      this.simulator.run(userId, scenarioType, baseParams),
      this.loans.debtSummary(userId),
      this.getLiquidInvestmentsValue(userId),
    ]);
    const surplus = computeMonthlySurplus(baseRun.baseline.monthlyIncome, baseRun.baseline.monthlyExpenses, Number(debtSummary.totalMonthlyEmi));

    const config = SCENARIO_FIELD_CONFIG[scenarioType];

    const variantValues = config.isAge
      ? this.buildAgeVariantValues(baseParams, config.field, baseRun.baseline.targetRetirementAge, baseRun.baseline.currentAge)
      : this.buildMagnitudeVariantValues(baseParams, config, surplus, liquidInvestmentsValue);

    const variants: ScenarioVariant[] = [];
    for (const label of VARIANT_LABELS) {
      const value = variantValues[label];
      const params = { ...baseParams, [config.field]: value };
      // "base" is exactly the already-computed baseRun — no need to re-run the engine
      // for a value that's identical to what was just computed.
      const run = label === "base" ? baseRun : await this.simulator.run(userId, scenarioType, params);
      const feasibility = this.assessFeasibility(scenarioType, value, surplus, baseRun, baseParams, liquidInvestmentsValue);

      variants.push({ label, params, run, feasible: feasibility.feasible, feasibilityNote: feasibility.note });
    }

    return variants;
  }

  // Real liquid-only investment value (Investment.liquidity === "LIQUID"), used as the
  // basis for LOAN_PREPAYMENT's affordability cap instead of total investment value —
  // see scenario-studio.constants.ts for why this is a meaningfully more accurate
  // guardrail than approximating against everything the user owns, including locked-in
  // instruments like PPF/EPF/NPS (SEMI_LIQUID/ILLIQUID) that can't realistically fund a
  // lump-sum prepayment.
  private async getLiquidInvestmentsValue(userId: string): Promise<number> {
    const holdings = await this.investments.list(userId);
    return holdings
      .filter((h) => h.liquidity === "LIQUID")
      .reduce((sum, h) => sum + Number(h.currentValue), 0);
  }

  private buildMagnitudeVariantValues(
    baseParams: Record<string, unknown>,
    config: (typeof SCENARIO_FIELD_CONFIG)[ScenarioType],
    surplus: number,
    liquidInvestmentsValue: number,
  ): Record<VariantLabel, number> {
    const literal = Number(baseParams[config.field]);
    const optimisticMultiplier = config.direction === "optimistic" ? VARIANT_MULTIPLIERS.best : VARIANT_MULTIPLIERS.worst;
    const pessimisticMultiplier = config.direction === "optimistic" ? VARIANT_MULTIPLIERS.worst : VARIANT_MULTIPLIERS.best;

    const best = literal * optimisticMultiplier;
    const worst = literal * pessimisticMultiplier;
    const base = literal;
    const constrained = config.isDiscretionarySpend
      ? this.applyAffordabilityCap(config.field, best, baseParams, surplus, liquidInvestmentsValue)
      : base; // no discretionary spend to cap — documented in scenario-studio.constants.ts

    return { best, base, worst, constrained };
  }

  private applyAffordabilityCap(
    field: string,
    proposedValue: number,
    baseParams: Record<string, unknown>,
    surplus: number,
    liquidInvestmentsValue: number,
  ): number {
    if (field === "additionalMonthlyAmount") {
      // SIP_INCREASE: cap the extra monthly commitment at what the user can actually
      // spare each month.
      return Math.max(0, Math.min(proposedValue, surplus));
    }
    if (field === "lumpSum") {
      // LOAN_PREPAYMENT: cap at a fraction of real liquid investment value — see
      // scenario-studio.constants.ts for why liquid-only, not total, investment value.
      return Math.max(0, Math.min(proposedValue, liquidInvestmentsValue * MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS));
    }
    if (field === "propertyValue") {
      // HOUSE_PURCHASE: cap the property value at what the user can actually afford
      // the EMI for — a real EMI-affordability inversion, not an arbitrary cap.
      const rate = Number(baseParams.loanInterestRateAnnual);
      const tenure = Number(baseParams.loanTenureMonths);
      const downPaymentPercent = Number(baseParams.downPaymentPercent);
      const maxPrincipal = maxAffordablePrincipal(surplus, rate, tenure);
      const downPaymentFraction = downPaymentPercent / 100;
      if (downPaymentFraction >= 1) return maxPrincipal; // 100% down payment — no loan, propertyValue == principal budget
      return maxPrincipal / (1 - downPaymentFraction);
    }
    return proposedValue;
  }

  private buildAgeVariantValues(
    baseParams: Record<string, unknown>,
    field: string,
    anchorAge: number,
    currentAge: number | null,
  ): Record<VariantLabel, number> {
    const literalAge = Number(baseParams[field]);
    const floor = (currentAge ?? anchorAge - 20) + 1;
    // Best case: retiring meaningfully later than today's target gives the most
    // investing runway in this engine's model (see scenario-studio.constants.ts).
    // Worst case: retiring meaningfully earlier, floored so it never goes below (or
    // to) the user's current age.
    const best = anchorAge + Math.abs(AGE_SENSITIVITY_DELTAS[AGE_SENSITIVITY_DELTAS.length - 1]);
    const worst = Math.max(floor, anchorAge + AGE_SENSITIVITY_DELTAS[0]);
    return { best, base: literalAge, worst, constrained: literalAge }; // no affordability angle for an age
  }

  private assessFeasibility(
    scenarioType: ScenarioType,
    value: number,
    surplus: number,
    baseRun: RunScenarioResponseDTO,
    baseParams: Record<string, unknown>,
    liquidInvestmentsValue: number,
  ): { feasible: boolean; note: string } {
    if (scenarioType === "SIP_INCREASE") {
      return value <= surplus
        ? { feasible: true, note: `Fits within your current monthly surplus of ₹${surplus.toFixed(0)}.` }
        : { feasible: false, note: `Exceeds your current monthly surplus of ₹${surplus.toFixed(0)} — would require cutting expenses or increasing income first.` };
    }
    if (scenarioType === "LOAN_PREPAYMENT") {
      const cap = liquidInvestmentsValue * MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS;
      return value <= cap
        ? { feasible: true, note: "Within a conservative share of your actual liquid investment value." }
        : { feasible: false, note: `Would mean liquidating more than ${(MAX_PREPAYMENT_FRACTION_OF_LIQUID_INVESTMENTS * 100).toFixed(0)}% of your liquid investment value (₹${liquidInvestmentsValue.toFixed(0)}) to fund it — locked-in holdings like PPF/EPF/NPS aren't counted as available.` };
    }
    if (scenarioType === "EMERGENCY_EXPENSE") {
      return value <= baseRun.baseline.netWorth
        ? { feasible: true, note: "Absorbable from current net worth." }
        : { feasible: false, note: "Would exceed current net worth — would likely require debt or a distressed asset sale." };
    }
    if (scenarioType === "HOUSE_PURCHASE") {
      const rate = Number(baseParams.loanInterestRateAnnual);
      const tenure = Number(baseParams.loanTenureMonths);
      const downPaymentPercent = Number(baseParams.downPaymentPercent);
      const principal = value * (1 - downPaymentPercent / 100);
      const emi = calculateEmi(principal, rate, tenure);
      return emi <= surplus
        ? { feasible: true, note: `Estimated EMI of ₹${emi.toFixed(0)}/month fits within your current surplus of ₹${surplus.toFixed(0)}.` }
        : { feasible: false, note: `Estimated EMI of ₹${emi.toFixed(0)}/month would exceed your current monthly surplus of ₹${surplus.toFixed(0)}.` };
    }
    return { feasible: true, note: "Not a discretionary spending decision, so no affordability check applies." };
  }
}
