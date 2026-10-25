import { Type } from "class-transformer";
import { IsDateString, IsIn, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength, ValidateNested } from "class-validator";
import { Transform } from "class-transformer";
import { CreateEmergencyEntryDto, MAX_AMOUNT } from "../../emergency-fund/dto/create-emergency-entry.dto";
import { UpdateEmergencyPlanDto } from "../../emergency-fund/dto/emergency-plan.dto";

// One user action = one requestId. A repeat of the same requestId (double-click, retry after a timeout)
// returns the first result and writes nothing.
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/;

export class GoalFundEntryDto extends CreateEmergencyEntryDto {
  @IsOptional()
  @Matches(REQUEST_ID, { message: "requestId must be 8-64 letters, digits, - or _" })
  requestId?: string;
}

export class GoalSpendDto {
  @IsIn(["EXPENSE", "OTHER_OUTFLOW"])
  mode!: "EXPENSE" | "OTHER_OUTFLOW";

  @IsString()
  categoryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;
}

// POST /goal-funds/:goalId/use — take money out of the goal; when it was SPENT, record that once.
export class UseGoalMoneyDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  reason?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => GoalSpendDto)
  spend?: GoalSpendDto;

  @IsOptional()
  @Matches(REQUEST_ID, { message: "requestId must be 8-64 letters, digits, - or _" })
  requestId?: string;
}

// POST /goal-funds/:goalId/reallocate — move set-aside cash from this goal to another.
export class ReallocateGoalMoneyDto {
  @IsString()
  toGoalId!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsOptional()
  @Matches(REQUEST_ID, { message: "requestId must be 8-64 letters, digits, - or _" })
  requestId?: string;
}

// PUT /goal-funds/:goalId/plan — same shape as the emergency plan. For any goal but the emergency
// reserve, a months-of-expenses target is refused and the amount cannot be cleared (a goal needs a target).
export class UpdateGoalPlanDto extends UpdateEmergencyPlanDto {}
