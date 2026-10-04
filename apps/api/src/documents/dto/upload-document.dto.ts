import { IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { DocumentCategory } from "@wealthos/db";
import { DOCUMENT_ENTITY_TYPES, DOCUMENT_TYPES } from "../document-entity.service";

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

  // NEW: optional link to the record this document is about, and its fine-grained kind. The
  // link is verified against the caller's own records in DocumentsService.
  @IsOptional()
  @IsIn(DOCUMENT_ENTITY_TYPES as unknown as string[])
  entityType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  entityId?: string;

  @IsOptional()
  @IsIn(DOCUMENT_TYPES as unknown as string[])
  documentType?: string;
}
