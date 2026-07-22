import { Type } from "class-transformer";
import { ArrayMinSize, IsArray, IsEnum, IsNumber, IsOptional, Max, Min, ValidateNested } from "class-validator";
import { InvestmentType } from "@wealthos/db";

export class RebalanceTargetDto {
  @IsEnum(InvestmentType)
  type!: InvestmentType;

  @IsNumber()
  @Min(0)
  @Max(100)
  percent!: number;
}

export class RebalancePortfolioDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => RebalanceTargetDto)
  targets!: RebalanceTargetDto[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  cashAvailable?: number;

  @IsOptional()
  @IsArray()
  @IsEnum(InvestmentType, { each: true })
  noSellTypes?: InvestmentType[];
}
