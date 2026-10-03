import { IsDateString, IsNumber, Max, Min } from "class-validator";
import { MAX_INVESTMENT_AMOUNT } from "./create-investment.dto";

// POST /investments/:id/valuations — the value of the holding as of a date. The latest
// valuation (by valuedAt) is the authoritative "current value".
export class CreateValuationDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(MAX_INVESTMENT_AMOUNT, { message: `value cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  value!: number;

  @IsDateString()
  valuedAt!: string;
}
