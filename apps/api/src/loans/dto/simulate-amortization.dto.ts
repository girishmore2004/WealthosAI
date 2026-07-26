import { Type } from "class-transformer";
import { IsArray, IsNumber, IsOptional, Min, ValidateNested } from "class-validator";
import { RateChangeDto } from "./rate-change.dto";

export class SimulateAmortizationDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RateChangeDto)
  rateChanges?: RateChangeDto[];

  // Optional one-time lump sum applied before the schedule starts, so a combined
  // "what if my rate changes AND I prepay" scenario can be run in one call.
  @IsOptional()
  @IsNumber()
  @Min(0)
  lumpSumPrepayment?: number;
}
