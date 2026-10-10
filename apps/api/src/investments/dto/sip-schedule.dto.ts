import { IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from "class-validator";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

// PUT /investments/:id/sip-schedule
export class SipScheduleDto {
  // The amount PER PERIOD. The field keeps its original name for backward compatibility: with the
  // default MONTHLY frequency it is exactly the monthly contribution it always was.
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT)
  monthlyContribution!: number;

  // How often the contribution recurs. Omitted = MONTHLY (what every existing client sends).
  @IsOptional()
  @IsIn(["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"])
  frequency?: "WEEKLY" | "BIWEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

  // Day of month (1-31, clamped to the month's length) for MONTHLY / QUARTERLY / YEARLY. Defaults
  // to the start date's day; ignored for WEEKLY / BIWEEKLY, which repeat from the start date.
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(31)
  contributionDay?: number;

  // The user's ASSUMED annual return in percent (e.g. 12), used only for projections. It never
  // changes any actual value or contribution.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(0)
  @Max(100)
  expectedAnnualReturn?: number;

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
