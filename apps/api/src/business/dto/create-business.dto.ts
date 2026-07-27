import { IsDateString, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";
import { Transform } from "class-transformer";
import { BusinessEntityType } from "@wealthos/db";

export class CreateBusinessDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  description?: string;

  @IsOptional()
  @IsEnum(BusinessEntityType)
  entityType?: BusinessEntityType;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim().toUpperCase() : value))
  @IsString()
  @MaxLength(8)
  currency?: string;

  @IsOptional()
  @IsDateString()
  startedAt?: string;
  // Deliberately no directional date guard — same reasoning as Loans' startDate: a
  // business's start date can legitimately be a near-future date (e.g. logging a
  // formally-registered business ahead of actually opening for trade).

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  ownershipPercent?: number;
}
