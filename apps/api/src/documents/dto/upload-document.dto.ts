import { IsDateString, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { DocumentCategory } from "@wealthos/db";

export class UploadDocumentDto {
  @IsEnum(DocumentCategory)
  category!: DocumentCategory;

  // Sent as a comma-separated string over multipart/form-data (e.g. "tax,fy2026-27");
  // parsed into string[] in the service.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  tags?: string;

  @IsOptional()
  @IsDateString()
  expiryDate?: string;
}
