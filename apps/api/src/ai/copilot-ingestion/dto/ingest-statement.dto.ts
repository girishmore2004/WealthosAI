import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { PaymentMethod } from "@wealthos/db";

export class IngestStatementDto {
  @IsString()
  @MaxLength(120)
  sourceLabel!: string;

  @IsString()
  @MinLength(10)
  @MaxLength(20000)
  rawText!: string;

  @IsEnum(PaymentMethod)
  defaultPaymentMethod!: PaymentMethod;
}
