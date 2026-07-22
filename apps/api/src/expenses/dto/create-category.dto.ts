import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { CategoryType } from "@wealthos/db";

export class CreateCategoryDto {
  @IsString()
  @MaxLength(60)
  name!: string;

  @IsEnum(CategoryType)
  type!: CategoryType;

  @IsOptional()
  @IsString()
  icon?: string;
}
