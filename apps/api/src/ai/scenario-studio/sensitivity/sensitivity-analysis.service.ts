import { Injectable } from "@nestjs/common";
import { SimulatorService } from "../../../simulator/simulator.service";
import { projectNetWorth } from "../../../simulator/simulator.engine";
import { RunScenarioResponseDTO, ScenarioType } from "@wealthos/types";
import { AGE_SENSITIVITY_DELTAS, RETURN_RATE_SENSITIVITY_PERCENTS, SCENARIO_FIELD_CONFIG, SENSITIVITY_MULTIPLIERS } from "../scenario-studio.constants";

export interface SensitivityPoint {
  paramValue: number;
  projectedNetWorthIn5Years: number;
  netWorthDeltaIn5Years: number;
}

export interface SensitivityDimension {
  dimension: string;
  field: string;
  points: SensitivityPoint[];
}

@Injectable()
export class SensitivityAnalysisService {
  constructor(private simulator: SimulatorService) {}

  async analyze(userId: string, scenarioType: ScenarioType, baseParams: Record<string, unknown>, baseRun: RunScenarioResponseDTO): Promise<SensitivityDimension[]> {
    const config = SCENARIO_FIELD_CONFIG[scenarioType];
    const dimensions: SensitivityDimension[] = [];

    dimensions.push(await this.sweepPrimaryField(userId, scenarioType, baseParams, config.field, config.isAge));
    dimensions.push(this.sweepReturnRate(baseRun));

    return dimensions;
  }

  private async sweepPrimaryField(
    userId: string,
    scenarioType: ScenarioType,
    baseParams: Record<string, unknown>,
    field: string,
    isAge: boolean | undefined,
  ): Promise<SensitivityDimension> {
    const literal = Number(baseParams[field]);
    const sweepValues = isAge ? AGE_SENSITIVITY_DELTAS.map((delta) => literal + delta) : SENSITIVITY_MULTIPLIERS.map((m) => literal * m);

    const points: SensitivityPoint[] = [];
    for (const value of sweepValues) {
      const run = await this.simulator.run(userId, scenarioType, { ...baseParams, [field]: value });
      points.push({
        paramValue: value,
        projectedNetWorthIn5Years: Number(run.result.projectedNetWorthIn5Years),
        netWorthDeltaIn5Years: Number(run.result.netWorthDeltaIn5Years),
      });
    }

    return { dimension: humanDimensionLabel(scenarioType), field, points };
  }

  // Substitutes for the roadmap's "inflation changes" sensitivity — see
  // scenario-studio.constants.ts for why (the deterministic engine models an assumed
  // investment return rate, not expense inflation, and this reuses that exact lever
  // rather than fabricating an inflation model with no real backing). Computed
  // directly against the baseline via the engine's own exported projectNetWorth
  // function (no new investment contribution assumed — this is "how would my current
  // baseline look under different long-run return assumptions", independent of
  // whichever specific scenario is being explored).
  private sweepReturnRate(baseRun: RunScenarioResponseDTO): SensitivityDimension {
    const months = 60; // 5-year horizon, matching PROJECTION_YEARS in simulator.engine.ts
    const points: SensitivityPoint[] = RETURN_RATE_SENSITIVITY_PERCENTS.map((ratePercent) => {
      const projected = projectNetWorth({
        monthlyIncome: baseRun.baseline.monthlyIncome,
        monthlyExpenses: baseRun.baseline.monthlyExpenses,
        monthlyInvestmentContribution: 0,
        investmentsValue: baseRun.baseline.investmentsValue,
        debt: baseRun.baseline.totalDebt,
        months,
        annualReturnPercent: ratePercent,
      });
      return {
        paramValue: ratePercent,
        projectedNetWorthIn5Years: projected,
        netWorthDeltaIn5Years: projected - Number(baseRun.result.projectedNetWorthIn5Years),
      };
    });

    return { dimension: "Assumed investment return rate (baseline, no new contribution) — closest available proxy for inflation/growth-rate sensitivity", field: "annualReturnPercent", points };
  }
}

function humanDimensionLabel(scenarioType: ScenarioType): string {
  const labels: Record<ScenarioType, string> = {
    SALARY_HIKE: "Salary hike size",
    SALARY_DROP: "Salary drop size",
    SIP_INCREASE: "Additional monthly SIP amount",
    SIP_DECREASE: "Reduced monthly SIP amount",
    HOUSE_PURCHASE: "Property value",
    LOAN_PREPAYMENT: "Loan prepayment lump sum",
    RETIREMENT_AGE_SHIFT: "Retirement age",
    EMERGENCY_EXPENSE: "Emergency expense size",
    GOAL_DELAY: "Goal delay length",
  };
  return labels[scenarioType];
}
