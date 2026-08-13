import { IsInt, IsNumber, Max, Min } from "class-validator";

// A single future rate reset for the floating-rate amortization simulation. See
// LoansService's RateChange interface and computeAmortizationSchedule() (common/finance-math) for how this is applied.
export class RateChangeDto {
  @IsInt()
  @Min(1)
  effectiveFromMonth!: number;

  // Same 0–50% sanity bound as CreateLoanDto's interestRateAnnual — a rate reset is
  // still an annual percentage rate for the same loan, so the same realistic ceiling
  // applies.
  @IsNumber()
  @Min(0)
  @Max(50)
  newAnnualRatePercent!: number;
}
