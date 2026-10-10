import { IsDateString, IsEnum, IsIn, IsOptional, IsString, Matches } from "class-validator";
import { ExpenseFlowType } from "@wealthos/db";
import { EXPENSE_PERIODS, ExpensePeriodName } from "./list-expenses-query.dto";

export class ExpenseAnalyticsQueryDto {
  // Defaults to THIS_MONTH when neither a period nor from/to is given.
  @IsOptional()
  @IsIn(EXPENSE_PERIODS as unknown as string[])
  period?: ExpensePeriodName;

  // CUSTOM range, both INCLUSIVE calendar days (UTC).
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "today must be YYYY-MM-DD" })
  today?: string;

  // Category drill-down: restricts every figure to this category.
  @IsOptional()
  @IsString()
  categoryId?: string;

  // Defaults to EXPENSE (ordinary spending).
  @IsOptional()
  @IsEnum(ExpenseFlowType)
  flowType?: ExpenseFlowType;
}
