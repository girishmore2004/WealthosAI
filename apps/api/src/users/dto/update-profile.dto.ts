import { IsEnum, IsOptional, IsString } from "class-validator";
import { RiskProfile, TaxRegime } from "@wealthos/db";

export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEnum(TaxRegime)
  taxRegime?: TaxRegime;

  @IsOptional()
  @IsEnum(RiskProfile)
  riskProfile?: RiskProfile;
}
