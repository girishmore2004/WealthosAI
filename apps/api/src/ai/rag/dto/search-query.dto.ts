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
}
