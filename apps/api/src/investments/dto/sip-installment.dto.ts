import { IsIn, IsNumber, IsOptional, IsPositive, IsString, Matches, Max, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

export const INSTALLMENT_STATUSES = ["CONFIRMED", "PENDING", "SKIPPED", "FAILED"] as const;
export type InstallmentStatusDto = (typeof INSTALLMENT_STATUSES)[number];

// POST /investments/:id/sip/installments — record what happened to ONE scheduled installment.
// CONFIRMED records the contribution (the only status that counts as invested); PENDING, SKIPPED and
// FAILED are remembered but never counted, and stop the schedule from auto-creating that period.
export class SipInstallmentDto {
  // "2026-09", "2026-Q3", "2026" or "2026-09-14" — the key the schedule itself uses for the period.
  @Matches(/^\d{4}(-\d{2}(-\d{2})?|-Q[1-4])?$/, { message: "periodKey must look like 2026-09, 2026-Q3, 2026 or 2026-09-14" })
  periodKey!: string;

  @IsIn(INSTALLMENT_STATUSES as unknown as string[])
  status!: InstallmentStatusDto;

  // Only for CONFIRMED; defaults to the schedule's amount for that period.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT)
  amount?: number;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  notes?: string;
}
