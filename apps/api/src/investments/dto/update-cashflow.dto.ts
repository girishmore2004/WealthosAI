import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

// PATCH /investments/:id/cashflows/:cashflowId — correct a mistyped amount, date or note. The type is
// deliberately not editable (a contribution is not a withdrawal); delete and re-enter instead.
export class UpdateCashflowDto {
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `amount cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  amount?: number;

  @IsOptional()
  @IsDateString()
  occurredAt?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;
}
