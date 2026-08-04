import { IsArray, IsDateString, IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { AiSourceType } from "@wealthos/db";

export class SearchQueryDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  query!: string;

  @IsOptional()
  @IsArray()
  @IsEnum(AiSourceType, { each: true })
  sourceTypes?: AiSourceType[];

  @IsOptional()
  @IsDateString()
  dateFrom?: string;

  @IsOptional()
  @IsDateString()
  dateTo?: string;

  // Metadata filtering — Document.category values to narrow to (e.g. "INSURANCE").
  // Only ever applied against DOCUMENT-sourced chunks; see
  // HybridRetrievalService#passesMetadataFilters for why other source types are left
  // untouched by this filter rather than wrongly excluded.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  categories?: string[];

  // Metadata filtering — Document.tags values, OR-matched (a chunk passes if it
  // shares at least one tag with this list).
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(60, { each: true })
  tags?: string[];
}
