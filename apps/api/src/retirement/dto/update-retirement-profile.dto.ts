import { IsInt, IsNumber, IsOptional, IsPositive, Max, Min } from "class-validator";

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
}
