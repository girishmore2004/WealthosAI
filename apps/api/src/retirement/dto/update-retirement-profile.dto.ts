import { IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from "class-validator";

// RetirementProfile.expectedMonthlyPensionAtRetirement is Decimal(12, 2) — 12 total
// digits, 2 after the decimal point, so the largest value it can hold is
// 9999999999.99. Same constant/reasoning as the equivalent guards already added across
// every other money module's DTOs this session.
export const MAX_PENSION_AMOUNT = 9999999999.99;

export class UpdateRetirementProfileDto {
  @IsOptional()
  @IsInt()
  @Min(35)
  @Max(75)
  targetRetirementAge?: number;

  @IsOptional()
  @IsNumber()
  @IsPositive()
  desiredMonthlyIncomeToday?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  inflationRatePercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(30)
  expectedReturnPreRetirementPercent?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(20)
  expectedReturnPostRetirementPercent?: number;

  // New. Upper bound of 110 is a generous sanity ceiling, not a claim about anyone's
  // actual life expectancy; the lower bound of 35 matches targetRetirementAge's own
  // floor, since a life expectancy below the earliest allowed retirement age can never
  // produce a meaningful drawdown horizon anyway. computePlan() additionally checks
  // this is actually greater than the CURRENT targetRetirementAge at calculation time
  // (not enforceable here at the DTO level alone, since the two fields can be updated
  // independently in separate requests) and falls back to the default horizon if not.
  @IsOptional()
  @IsInt()
  @Min(35)
  @Max(110)
  lifeExpectancyAge?: number;

  // New. Nominal rupees AT the retirement date (not today's rupees) — same
  // "already future-valued" convention as desiredMonthlyIncomeToday's projected
  // monthlyIncomeAtRetirement figure. 0 (or leaving this unset) means "no pension
  // income assumed," identical to the original behavior.
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_PENSION_AMOUNT, { message: `expectedMonthlyPensionAtRetirement cannot exceed ${MAX_PENSION_AMOUNT}` })
  expectedMonthlyPensionAtRetirement?: number;
}
