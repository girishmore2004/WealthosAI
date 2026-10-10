import { Type } from "class-transformer";
import { IsDateString, IsEnum, IsIn, IsInt, IsOptional, IsString, Matches, Max, Min } from "class-validator";
import { ExpenseFlowType, PaymentMethod } from "@wealthos/db";

export const EXPENSE_PERIODS = [
  "TODAY",
  "YESTERDAY",
  "THIS_WEEK",
  "LAST_WEEK",
  "THIS_MONTH",
  "LAST_MONTH",
  "THIS_YEAR",
  "LAST_YEAR",
  "CUSTOM",
] as const;
export type ExpensePeriodName = (typeof EXPENSE_PERIODS)[number];

export const EXPENSE_SORTS = ["NEWEST", "OLDEST", "HIGHEST", "LOWEST"] as const;
export type ExpenseSort = (typeof EXPENSE_SORTS)[number];

export class ListExpensesQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  // Capped at 100 — matches IncomeService's identical pagination convention; keeps a
  // single request bounded regardless of how much expense history an account has.
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number;

  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  // Date preset resolved on the server (weeks start Monday, all in UTC calendar days). When
  // supplied (and not CUSTOM) it takes precedence over from/to.
  @IsOptional()
  @IsIn(EXPENSE_PERIODS as unknown as string[])
  period?: ExpensePeriodName;

  // The caller's local "today" (YYYY-MM-DD). Presets are relative to it, so a user in
  // UTC+5:30 at 1 AM still sees THEIR today rather than the server's. Defaults to the UTC date.
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "today must be YYYY-MM-DD" })
  today?: string;

  // Omitted = every kind of expense row (the page can show OTHER_OUTFLOW rows too).
  @IsOptional()
  @IsEnum(ExpenseFlowType)
  flowType?: ExpenseFlowType;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsIn(EXPENSE_SORTS as unknown as string[])
  sort?: ExpenseSort;
}
