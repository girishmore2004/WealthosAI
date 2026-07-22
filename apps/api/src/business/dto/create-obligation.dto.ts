import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { Recurrence, ObligationStatus } from "@wealthos/db";

export class CreateObligationDto {
  @IsString()
  @MaxLength(120)
  title!: string;

  @IsDateString()
  dueDate!: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsEnum(Recurrence)
  recurrence?: Recurrence;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  vendor?: string;

  @IsOptional()
  @IsEnum(ObligationStatus)
  status?: ObligationStatus;

  @IsOptional()
  @IsString()
  notes?: string;
}
