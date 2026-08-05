import { IsArray, IsBoolean, IsIn, IsNumber, IsOptional, IsString, Max, Min } from "class-validator";
import { ScenarioType } from "@wealthos/types";

// Kept in sync with OPTIMIZABLE_SCENARIO_TYPES in scenario-studio.constants.ts —
// duplicated here (rather than imported) because class-validator decorators need a
// literal array at class-definition time; ScenarioOptimizerService.optimize() is the
// actual source of truth and re-validates against the constants file regardless, so a
// caller can never bypass the real check even if this list ever drifts.
const OPTIMIZABLE_TYPES: ScenarioType[] = ["SIP_INCREASE", "LOAN_PREPAYMENT", "RETIREMENT_AGE_SHIFT", "GOAL_DELAY"];

export class OptimizeScenarioStudioDto {
  @IsIn(OPTIMIZABLE_TYPES)
  scenarioType!: ScenarioType;

  // Required (checked in ScenarioOptimizerService.optimize()) when scenarioType is
  // LOAN_PREPAYMENT — which loan to search a prepayment amount for.
  @IsOptional()
  @IsString()
  loanId?: string;

  // Required (checked in ScenarioOptimizerService.optimize()) when scenarioType is
  // GOAL_DELAY — which goal to search a delay length for.
  @IsOptional()
  @IsString()
  goalId?: string;

  // Fraction (0.1–1) of real monthly surplus the optimizer may commit to a new
  // SIP/EMI. Defaults to DEFAULT_MAX_BUDGET_FRACTION_OF_SURPLUS (0.8) when omitted.
  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(1)
  maxMonthlyBudgetPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(18)
  minRetirementAge?: number;

  @IsOptional()
  @IsNumber()
  @Max(100)
  maxRetirementAge?: number;

  // Default true — set to false to skip the goal-funding constraint check entirely.
  @IsOptional()
  @IsBoolean()
  respectGoalFunding?: boolean;

  // Default true (SIP_INCREASE only) — set to false to search past the real Section
  // 80C headroom (e.g. a user deliberately investing outside tax-advantaged
  // instruments).
  @IsOptional()
  @IsBoolean()
  respectTaxAdvantagedLimit?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetGoalIds?: string[];
}
