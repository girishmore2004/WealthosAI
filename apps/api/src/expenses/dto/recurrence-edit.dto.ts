import { IsBoolean, IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { ExpenseFlowType, PaymentMethod, Recurrence } from "@wealthos/db";
import { MAX_EXPENSE_AMOUNT } from "./create-expense.dto";

// ?scope= on PATCH /expenses/:id. Omitted = THIS (the safe default: only that one row changes).
export class ExpenseEditScopeQueryDto {
  @IsOptional()
  @IsIn(["THIS", "FUTURE"])
  scope?: "THIS" | "FUTURE";
}

// ?mode= on DELETE /expenses/:id. Omitted = THIS (delete only that one row).
export class ExpenseDeleteModeQueryDto {
  @IsOptional()
  @IsIn(["THIS", "FUTURE"])
  mode?: "THIS" | "FUTURE";
}

// PATCH /expenses/:id/recurrence — edits the RULE: how later occurrences are generated. It never
// changes any expense that already exists (history is untouched), including the template row's
// own values.
export class UpdateRecurrenceRuleDto {
  // Any cadence except ONE_TIME (a rule that doesn't repeat is just "stop the recurrence").
  @IsOptional()
  @IsEnum(Recurrence)
  recurrence?: Recurrence;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  // endDate cannot be sent as null through the validators, so clearing it is an explicit flag.
  @IsOptional()
  @IsBoolean()
  clearEndDate?: boolean;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_EXPENSE_AMOUNT)
  amount?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsEnum(ExpenseFlowType)
  flowType?: ExpenseFlowType;
}
