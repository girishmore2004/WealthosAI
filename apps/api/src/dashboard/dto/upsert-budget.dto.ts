import { IsNumber, IsPositive, IsString, Max } from "class-validator";

// Budget.monthlyAmount is Decimal(12, 2) — 12 total digits, 2 after the decimal point,
// so the largest value it can hold is 9999999999.99. Same constant/reasoning as the
// equivalent guards already added across every other money module's DTOs this session.
export const MAX_BUDGET_AMOUNT = 9999999999.99;

export class UpsertBudgetDto {
  @IsString()
  categoryId!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_BUDGET_AMOUNT, { message: `monthlyAmount cannot exceed ${MAX_BUDGET_AMOUNT}` })
  monthlyAmount!: number;
}
