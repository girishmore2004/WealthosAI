import { IsEnum, IsNumber, IsPositive, IsString, Matches, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { TaxSection } from "@wealthos/db";

// TaxDeduction.amount is Decimal(12, 2) in the schema — 12 total digits, 2 after the
// decimal point, so the largest value it can hold is 9999999999.99. Same
// constant/reasoning as the equivalent guards already added across every other money
// module's DTOs this session (matches BusinessObligation's and Property's ancillary
// fields' precision, not the larger Decimal(14,2) precision used elsewhere).
export const MAX_DEDUCTION_AMOUNT = 9999999999.99;

export class CreateDeductionDto {
  @IsEnum(TaxSection)
  section!: TaxSection;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(160)
  description!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_DEDUCTION_AMOUNT, { message: `amount cannot exceed ${MAX_DEDUCTION_AMOUNT}` })
  amount!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: "financialYear must look like 2026-27" })
  financialYear!: string;
}
