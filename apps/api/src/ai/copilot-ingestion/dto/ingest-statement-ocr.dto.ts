import { IsEnum, IsString, MaxLength } from "class-validator";
import { PaymentMethod } from "@wealthos/db";

// The image file itself arrives as multipart form data (see
// FileInterceptor("file") on CopilotIngestionController#createBatchFromOcr) — this DTO
// only validates the accompanying form fields, the same split documents.controller.ts
// uses for its own upload endpoint.
export class IngestStatementOcrDto {
  @IsString()
  @MaxLength(120)
  sourceLabel!: string;

  @IsEnum(PaymentMethod)
  defaultPaymentMethod!: PaymentMethod;
}
