import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { PaymentMethod } from "@wealthos/db";

// Receivable.originalAmount is Decimal(14, 2): the largest value the column holds.
export const MAX_RECEIVABLE_AMOUNT = 999999999999.99;

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

export class CreateReceivableDto {
  // Person or entity the money was given to.
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  person!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  purpose?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_RECEIVABLE_AMOUNT)
  amount!: number;

  @IsDateString()
  givenAt!: string;

  @IsOptional()
  @IsDateString()
  expectedReturnAt?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
