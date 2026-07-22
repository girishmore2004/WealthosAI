import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { PaymentMethod } from "@wealthos/db";

export class CreateExpenseDto {
  @IsString()
  categoryId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsDateString()
  spentAt!: string;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
