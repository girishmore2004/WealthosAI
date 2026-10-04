import { IsArray, IsDateString, IsEnum, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { DocumentCategory } from "@wealthos/db";
import { DOCUMENT_ENTITY_TYPES, DOCUMENT_TYPES } from "../document-entity.service";

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

  // NEW: link / re-link / unlink. Send BOTH as null to unlink. A change is re-verified against
  // the caller's own records.
  @IsOptional()
  @IsIn(DOCUMENT_ENTITY_TYPES as unknown as string[])
  entityType?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  entityId?: string | null;

  @IsOptional()
  @IsIn(DOCUMENT_TYPES as unknown as string[])
  documentType?: string | null;
}
