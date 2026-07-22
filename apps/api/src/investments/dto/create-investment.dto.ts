import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { InvestmentType, RiskLevel, Liquidity } from "@wealthos/db";

export class CreateInvestmentDto {
  @IsEnum(InvestmentType)
  type!: InvestmentType;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @IsPositive()
  currentValue!: number;

  @IsNumber()
  @IsPositive()
  costBasis!: number;

  @IsDateString()
  purchaseDate!: string;

  @IsOptional()
  @IsEnum(RiskLevel)
  riskLevel?: RiskLevel;

  @IsOptional()
  @IsEnum(Liquidity)
  liquidity?: Liquidity;

  @IsOptional()
  @IsString()
  goalId?: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
