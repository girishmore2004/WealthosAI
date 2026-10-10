import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, Max, Min } from "class-validator";

export const PROJECTION_CADENCES = ["WEEKLY", "BIWEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;
export const DEFAULT_PROJECTION_YEARS = [5, 10, 15, 20, 25];
export const MAX_PROJECTION_YEARS = 50;

// "5,10,15" → [5, 10, 15]; also accepts a repeated ?years=5&years=10. De-duplicated and sorted so
// the response order is always ascending.
const toYears = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === "") return undefined;
  const parts = Array.isArray(value) ? value : String(value).split(",");
  return Array.from(new Set(parts.map((p) => Number(String(p).trim())))).sort((a, b) => a - b);
};

class YearsMixin {
  // Horizons in whole years (default 5, 10, 15, 20, 25).
  @IsOptional()
  @Transform(toYears)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(MAX_PROJECTION_YEARS, { each: true })
  years?: number[];
}

// GET /investments/projection — a stateless "what if" calculator. Nothing is read from or written to
// the user's data; every figure it returns is a PROJECTION from the assumptions in the request.
export class ProjectionQueryDto extends YearsMixin {
  // The starting value. Defaults to 0 (a brand-new plan).
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  currentValue?: number;

  // Amount added each period.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  contribution?: number;

  @IsOptional()
  @IsIn(PROJECTION_CADENCES as unknown as string[])
  frequency?: (typeof PROJECTION_CADENCES)[number];

  // REQUIRED: the assumed annual return is the whole point of a projection, so it is always an
  // explicit choice and never a hidden default. Percent (12 = 12%).
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  annualReturn!: number;
}

// GET /investments/projection/portfolio — projects the user's actual holdings and active schedules.
export class PortfolioProjectionQueryDto extends YearsMixin {
  // Assumed return for holdings that have no expected return of their own. Without it (and without a
  // per-holding value) a holding is left out of the projection and listed as excluded — it is never
  // projected on a number nobody chose.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  annualReturn?: number;
}
