import { IsDateString, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

// AccountTransfer.amount is Decimal(14, 2).
export const MAX_TRANSFER_AMOUNT = 999999999999.99;

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateTransferDto {
  // Free-text labels for the user's OWN accounts (e.g. "HDFC Savings", "Paytm Wallet").
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  fromAccount!: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  toAccount!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_TRANSFER_AMOUNT)
  amount!: number;

  @IsDateString()
  transferredAt!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
