import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { InsuranceType, Recurrence } from "@wealthos/db";

// InsurancePolicy.premiumAmount and .coverageAmount are both Decimal(14, 2) in the
// schema — 14 total digits, 2 after the decimal point, so the largest value either
// column can actually hold is 999999999999.99. Without this check, a value above that
// limit passes DTO validation and only fails when Postgres rejects the insert with a
// numeric field overflow — an opaque 500 instead of a clear 400. (Same constant/
// reasoning as the equivalent guards already added to Income/Expenses/Investments/
// Loans' DTOs.)
export const MAX_POLICY_AMOUNT = 999999999999.99;

export class CreatePolicyDto {
  @IsEnum(InsuranceType)
  type!: InsuranceType;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  provider!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(60)
  policyNumber?: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_POLICY_AMOUNT, { message: `premiumAmount cannot exceed ${MAX_POLICY_AMOUNT}` })
  premiumAmount!: number;

  @IsEnum(Recurrence)
  premiumFrequency!: Recurrence;

  @IsNumber()
  @IsPositive()
  @Max(MAX_POLICY_AMOUNT, { message: `coverageAmount cannot exceed ${MAX_POLICY_AMOUNT}` })
  coverageAmount!: number;

  @IsDateString()
  renewalDate!: string;
  // Deliberately no directional (past/future) sanity guard here — same reasoning as
  // Loans' startDate: a renewal date has no natural directional constraint (a lapsed,
  // not-yet-renewed policy's renewalDate is legitimately in the past; a freshly issued
  // multi-year policy's is legitimately far in the future), unlike Income/Expenses/
  // Investments' inherently-retrospective date fields.

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  nomineeName?: string;

  // NEW (audit item #13): optional link to a household Dependent, alongside (not
  // replacing) nomineeName above. Ownership/household-membership is verified in
  // InsuranceService (a plain string id here can't itself prove the dependent belongs
  // to the caller's household — see assertDependentOwnership()).
  @IsOptional()
  @IsString()
  nomineeDependentId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
