import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import { Transform } from "class-transformer";
import { InvestmentType, RiskLevel, Liquidity } from "@wealthos/db";

// Investment.currentValue and Investment.costBasis are both Decimal(14, 2) in the schema
// — 14 total digits, 2 after the decimal point, so the largest value either column can
// actually hold is 999999999999.99. Without this check, a value above that limit passes
// DTO validation and only fails when Postgres rejects the insert with a numeric field
// overflow — an opaque 500 instead of a clear 400. (Same constant/reasoning as the
// equivalent guard in Income/Expenses' DTOs, kept local to this file.)
export const MAX_INVESTMENT_AMOUNT = 999999999999.99;

// Self-contained custom validator, not shared with other modules' DTOs. Rejects a
// purchaseDate more than `maxFutureDays` in the future — you cannot have already
// purchased something that hasn't happened yet. Mainly catches an accidental wrong-year
// typo before it corrupts holding-period-based logic. A 1-day grace window absorbs
// timezone differences between the client's local date and the server's clock.
function IsNotFarFutureDate(maxFutureDays = 1, validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isNotFarFutureDate",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      constraints: [maxFutureDays],
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          if (typeof value !== "string") return true; // let @IsDateString report type errors
          const date = new Date(value);
          if (Number.isNaN(date.getTime())) return true; // let @IsDateString report format errors
          const [maxDays] = args.constraints as [number];
          const cutoff = new Date();
          cutoff.setDate(cutoff.getDate() + maxDays);
          return date.getTime() <= cutoff.getTime();
        },
        defaultMessage(args: ValidationArguments) {
          const [maxDays] = args.constraints as [number];
          return `purchaseDate cannot be more than ${maxDays} day(s) in the future`;
        },
      },
    });
  };
}

export class CreateInvestmentDto {
  @IsEnum(InvestmentType)
  type!: InvestmentType;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `currentValue cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  currentValue!: number;

  @IsNumber()
  @IsPositive()
  @Max(MAX_INVESTMENT_AMOUNT, { message: `costBasis cannot exceed ${MAX_INVESTMENT_AMOUNT}` })
  costBasis!: number;

  @IsDateString()
  @IsNotFarFutureDate(1)
  purchaseDate!: string;

  @IsOptional()
  @IsEnum(RiskLevel)
  riskLevel?: RiskLevel;

  @IsOptional()
  @IsEnum(Liquidity)
  liquidity?: Liquidity;

  @IsOptional()
  @IsString()
  goalId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
