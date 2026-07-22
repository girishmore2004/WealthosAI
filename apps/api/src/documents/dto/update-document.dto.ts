import { IsArray, IsDateString, IsEnum, IsOptional, IsString } from "class-validator";
import { DocumentCategory } from "@wealthos/db";

export class UpdateDocumentDto {
  @IsOptional()
  @IsEnum(DocumentCategory)
  category?: DocumentCategory;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}
