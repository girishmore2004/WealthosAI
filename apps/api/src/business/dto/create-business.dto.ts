import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { BusinessEntityType } from "@wealthos/db";

export class CreateBusinessDto {
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(BusinessEntityType)
  entityType?: BusinessEntityType;

  @IsOptional()
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsDateString()
  startedAt?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  ownershipPercent?: number;
}
