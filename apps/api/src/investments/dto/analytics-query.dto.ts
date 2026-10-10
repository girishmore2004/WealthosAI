import { Type } from "class-transformer";
import { IsInt, IsOptional, Max, Min } from "class-validator";

export class InvestmentAnalyticsQueryDto {
  // How many calendar months of trend to return, ending with the current one (default 12, max 36).
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(36)
  months?: number;
}
