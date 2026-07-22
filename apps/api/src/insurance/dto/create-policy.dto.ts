import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { InsuranceType, Recurrence } from "@wealthos/db";

export class CreatePolicyDto {
  @IsEnum(InsuranceType)
  type!: InsuranceType;

  @IsString()
  @MaxLength(120)
  provider!: string;

  @IsOptional()
  @IsString()
  policyNumber?: string;

  @IsNumber()
  @IsPositive()
  premiumAmount!: number;

  @IsEnum(Recurrence)
  premiumFrequency!: Recurrence;

  @IsNumber()
  @IsPositive()
  coverageAmount!: number;

  @IsDateString()
  renewalDate!: string;

  @IsOptional()
  @IsString()
  nomineeName?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
