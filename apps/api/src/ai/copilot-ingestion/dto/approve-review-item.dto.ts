import { IsDateString, IsEnum, IsIn, IsNumber, IsOptional, IsPositive, IsString, MaxLength } from "class-validator";
import { PaymentMethod } from "@wealthos/db";

export class ApproveReviewItemDto {
  @IsOptional()
  @IsString()
  categoryId?: string;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  amount?: number;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @IsOptional()
  @IsDateString()
  spentAt?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsOptional()
  @IsIn(["kept_both", "skipped_duplicate", "merged"])
  duplicateResolution?: "kept_both" | "skipped_duplicate" | "merged";
}
