import { IsBoolean, IsDateString, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from "class-validator";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

// PUT /investments/:id/sip-schedule
export class SipScheduleDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT)
  monthlyContribution!: number;

  @IsInt()
  @Min(1)
  @Max(31)
  contributionDay!: number;

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsBoolean()
  active!: boolean;

  // Required when activating with a start date before the current month: it will generate
  // historical contributions as ACTUAL cashflows, which must be a conscious choice.
  @IsOptional()
  @IsBoolean()
  confirmBackfill?: boolean;
}
