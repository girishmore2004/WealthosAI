import { Transform, Type } from "class-transformer";
import { IsDateString, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { CASHFLOW_TYPES, CashflowTypeDto } from "./create-cashflow.dto";

export const TRANSACTION_SORTS = ["date_desc", "date_asc", "amount_desc", "amount_asc"] as const;
export type TransactionSort = (typeof TRANSACTION_SORTS)[number];

// GET /investments/transactions — the portfolio-wide ledger, filtered and paged server-side.
export class ListTransactionsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) pageSize?: number;

  @IsOptional() @IsIn(CASHFLOW_TYPES as unknown as string[]) type?: CashflowTypeDto;
  @IsOptional() @IsString() @MaxLength(40) investmentId?: string;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;

  // Matches the note text or the holding's name.
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  q?: string;

  @IsOptional() @IsIn(TRANSACTION_SORTS as unknown as string[]) sort?: TransactionSort;
}
