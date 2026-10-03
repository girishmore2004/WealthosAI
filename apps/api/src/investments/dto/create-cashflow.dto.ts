import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

export const CASHFLOW_TYPES = [
  "CONTRIBUTION", "WITHDRAWAL", "SALE", "DIVIDEND", "FEE",
  "EMPLOYER_CONTRIBUTION", "INTEREST", "TRANSFER_IN", "TRANSFER_OUT",
] as const;
export type CashflowTypeDto = (typeof CASHFLOW_TYPES)[number];

// POST /investments/:id/cashflows — one dated money movement. `amount` is always positive;
// the direction comes from `type`. Manual entries carry no periodKey (so any number of
// manual contributions per month are allowed); only generated SIP rows are period-keyed.
export class CreateCashflowDto {
  @IsEnum(CASHFLOW_TYPES)
  type!: CashflowTypeDto;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `amount cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;
}
