import { IsIn, IsInt, IsNumber, IsObject, IsOptional, Max, Min } from "class-validator";
import { ScenarioType } from "@wealthos/types";

const SCENARIO_TYPES: ScenarioType[] = [
  "SALARY_HIKE",
  "SALARY_DROP",
  "SIP_INCREASE",
  "SIP_DECREASE",
  "HOUSE_PURCHASE",
  "LOAN_PREPAYMENT",
  "RETIREMENT_AGE_SHIFT",
  "EMERGENCY_EXPENSE",
  "GOAL_DELAY",
];

// All Monte Carlo config fields are optional overrides — omitted fields fall back to
// DEFAULT_MC_ITERATIONS / DEFAULT_MC_ASSUMPTIONS in scenario-studio.constants.ts.
// Bounds here match MonteCarloSimulationService's own clamping (Math.min/Math.max) so
// an out-of-range request fails fast with a clear 400 instead of silently being
// clamped without the caller knowing.
export class SimulateScenarioStudioDto {
  @IsIn(SCENARIO_TYPES)
  scenarioType!: ScenarioType;

  @IsObject()
  params!: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(200)
  @Max(5000)
  iterations?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(50)
  horizonYears?: number;

  @IsOptional()
  @IsInt()
  seed?: number;

  @IsOptional()
  @IsNumber()
  annualReturnMeanPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  annualReturnStdDevPercent?: number;

  @IsOptional()
  @IsNumber()
  expenseInflationMeanPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  expenseInflationStdDevPercent?: number;

  @IsOptional()
  @IsNumber()
  incomeGrowthMeanPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  incomeGrowthStdDevPercent?: number;

  @IsOptional()
  @IsNumber()
  propertyAppreciationMeanPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  propertyAppreciationStdDevPercent?: number;
}
