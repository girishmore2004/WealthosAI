import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { IncomeSource, Recurrence } from "@wealthos/db";

export class CreateIncomeDto {
  @IsEnum(IncomeSource)
  source!: IncomeSource;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsEnum(Recurrence)
  recurrence!: Recurrence;

  @IsDateString()
  receivedAt!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
