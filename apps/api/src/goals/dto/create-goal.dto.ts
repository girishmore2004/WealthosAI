import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, Min, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { GoalType } from "@wealthos/db";

// Goal.targetAmount, .currentAmount, and .monthlyContribution are all Decimal(14, 2) in
// the schema — 14 total digits, 2 after the decimal point, so the largest value any of
// them can hold is 999999999999.99. Same constant/reasoning as the equivalent guards
// already added across every other money module's DTOs this session.
export const MAX_GOAL_AMOUNT = 999999999999.99;

export class CreateGoalDto {
  @IsEnum(GoalType)
  type!: GoalType;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_GOAL_AMOUNT, { message: `targetAmount cannot exceed ${MAX_GOAL_AMOUNT}` })
  targetAmount!: number;

  @IsDateString()
  targetDate!: string;
  // Deliberately no directional (past/future) sanity guard — the service explicitly
  // supports (and is tested against) an already-passed targetDate, treated as an
  // overdue-but-still-tracked goal rather than rejected.

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_GOAL_AMOUNT, { message: `currentAmount cannot exceed ${MAX_GOAL_AMOUNT}` })
  currentAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_GOAL_AMOUNT, { message: `monthlyContribution cannot exceed ${MAX_GOAL_AMOUNT}` })
  monthlyContribution?: number;

  // New. Optional assumed annual growth rate for this goal's linked investment
  // holdings — see GoalsService.enrich()'s doc comment. 0–30% mirrors the realistic
  // return-rate ceiling used elsewhere in the app (e.g. Retirement's
  // expectedReturnPreRetirementPercent). Leaving this unset assumes 0% growth,
  // identical to the original calculation's implicit behavior.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  assumedAnnualReturnPercent?: number;
}
