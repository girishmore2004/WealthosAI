import { IsBoolean, IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength, Min } from "class-validator";
import { PropertyType } from "@wealthos/db";

export class CreatePropertyDto {
  @IsEnum(PropertyType)
  type!: PropertyType;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsNumber()
  @IsPositive()
  currentValue!: number;

  @IsNumber()
  @IsPositive()
  purchasePrice!: number;

  @IsDateString()
  purchaseDate!: string;

  @IsOptional()
  @IsBoolean()
  isRented?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyRentalIncome?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  annualMaintenanceCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  annualPropertyTax?: number;

  @IsOptional()
  @IsString()
  loanId?: string;

  @IsOptional()
  @IsString()
  insurancePolicyId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
