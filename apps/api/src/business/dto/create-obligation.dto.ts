import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { Recurrence, ObligationStatus } from "@wealthos/db";

// BusinessObligation.amount is a SEPARATE, SMALLER Decimal(12, 2) than
// BusinessTransaction.amount's Decimal(14, 2) — confirmed by direct schema read. 12
// total digits, 2 after the decimal, so the largest value this field can hold is
// 9999999999.99. Using the transaction DTO's larger constant here would still let a
// value through that Postgres would reject — the two limits are genuinely different.
export const MAX_OBLIGATION_AMOUNT = 9999999999.99;

export class CreateObligationDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  title!: string;

  @IsDateString()
  dueDate!: string;
  // Deliberately no directional (past/future) sanity guard — same reasoning as Loans'
  // startDate / Insurance's renewalDate: an obligation can legitimately be logged as
  // already overdue (ObligationStatus includes OVERDUE) or far in the future (an
  // annual filing set up a year ahead), so there's no single correct direction to
  // reject.

  @IsOptional()
  @IsNumber()
  @IsPositive()
  @Max(MAX_OBLIGATION_AMOUNT, { message: `amount cannot exceed ${MAX_OBLIGATION_AMOUNT}` })
  amount?: number;

  @IsOptional()
  @IsEnum(Recurrence)
  recurrence?: Recurrence;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  vendor?: string;

  @IsOptional()
  @IsEnum(ObligationStatus)
  status?: ObligationStatus;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
