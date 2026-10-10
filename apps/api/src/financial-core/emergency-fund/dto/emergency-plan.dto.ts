import { Type } from "class-transformer";
import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min, ValidateNested } from "class-validator";
import { MAX_AMOUNT } from "./create-emergency-entry.dto";

// PUT /emergency-fund/plan. Every field is optional: omitted = unchanged, null = clear. The target is
// EITHER an amount OR a number of months of essential expenses; sending one clears the other, and
// sending both is rejected by the service.
export class UpdateEmergencyPlanDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  targetAmount?: number | null;

  // Months of essential expenses to keep in reserve (0.5 – 60, one decimal).
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0.5)
  @Max(60)
  targetMonths?: number | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  monthlyContribution?: number | null;

  @IsOptional()
  @IsDateString()
  targetDate?: string | null;
}

export class UseEmergencyExpenseDto {
  @IsString()
  categoryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;
}

// POST /emergency-fund/use — take money out of the reserve and, when it was actually SPENT, record that
// spending as a genuine Expense in the same transaction. The withdrawal itself is never an expense (and
// never income); the expense is what the money was consumed by.
export class UseEmergencyMoneyDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  reason?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  // Present = "this was spent" → also create the Expense. Absent = the money simply left the reserve.
  @IsOptional()
  @ValidateNested()
  @Type(() => UseEmergencyExpenseDto)
  expense?: UseEmergencyExpenseDto;
}
