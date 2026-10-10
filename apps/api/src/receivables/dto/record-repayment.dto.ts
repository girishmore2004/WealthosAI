import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, MinLength } from "class-validator";
import { PaymentMethod } from "@wealthos/db";
import { MAX_RECEIVABLE_AMOUNT } from "./create-receivable.dto";

export class RecordRepaymentDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_RECEIVABLE_AMOUNT)
  amount!: number;

  @IsDateString()
  returnedAt!: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  // Client-generated (e.g. a UUID per form submission). Re-sending the same key for the same
  // receivable returns the original repayment instead of recording a second one.
  @IsOptional()
  @IsString()
  @MinLength(8)
  @MaxLength(100)
  idempotencyKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
