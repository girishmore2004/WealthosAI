import { IsEnum, IsNumber, IsPositive, IsString, Matches, MaxLength } from "class-validator";
import { TaxSection } from "@wealthos/db";

export class CreateDeductionDto {
  @IsEnum(TaxSection)
  section!: TaxSection;

  @IsString()
  @MaxLength(160)
  description!: string;

  @IsNumber()
  @IsPositive()
  amount!: number;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/, { message: "financialYear must look like 2026-27" })
  financialYear!: string;
}
