import { IsIn, IsISO8601, IsNumber, IsOptional, IsString, MaxLength, Min, MinLength } from "class-validator";
import { COACH_PLAN_TARGET_METRICS, CoachPlanTargetMetric } from "../coach2.constants";

const PLAN_TYPES = ["DEBT_PAYOFF", "SAVINGS_TARGET", "RETIREMENT", "INVESTMENT_ALLOCATION", "CUSTOM"] as const;

export class CreatePlanDto {
  @IsIn(PLAN_TYPES)
  type!: (typeof PLAN_TYPES)[number];

  @IsString()
  @MinLength(3)
  @MaxLength(120)
  title!: string;

  @IsString()
  @MinLength(3)
  @MaxLength(500)
  objective!: string;

  @IsIn(COACH_PLAN_TARGET_METRICS)
  targetMetricType!: CoachPlanTargetMetric;

  @IsNumber()
  @Min(0.01)
  targetValue!: number;

  @IsISO8601()
  targetDate!: string;

  @IsNumber()
  @Min(0)
  startingValue!: number;

  @IsOptional()
  @IsString()
  linkedGoalId?: string;

  @IsOptional()
  @IsString()
  linkedLoanId?: string;
}
