import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { CategoryType } from "@wealthos/db";

export class CreateCategoryDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsEnum(CategoryType)
  type!: CategoryType;

  @IsOptional()
  @IsString()
  icon?: string;
}
