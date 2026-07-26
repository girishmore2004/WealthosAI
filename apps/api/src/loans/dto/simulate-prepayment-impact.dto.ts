import { Type } from "class-transformer";
import { IsArray, IsNumber, IsOptional, IsPositive, ValidateNested } from "class-validator";
import { RateChangeDto } from "./rate-change.dto";

export class SimulatePrepaymentImpactDto {
  @IsNumber()
  @IsPositive()
  lumpSum!: number;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RateChangeDto)
  rateChanges?: RateChangeDto[];
}
