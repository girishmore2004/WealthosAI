import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { BusinessTransactionType } from "@wealthos/db";

export class CreateTransactionDto {
  @IsEnum(BusinessTransactionType)
  type!: BusinessTransactionType;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsDateString()
  occurredAt!: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
