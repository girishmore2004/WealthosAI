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
import { IncomeSource, Recurrence } from "@wealthos/db";

// Income.amount is Decimal(14, 2) in the schema — 14 total digits, 2 after the decimal
// point, so the largest value the column can actually hold is 999999999999.99. Without
// this check, an amount above that limit passes DTO validation and only fails when
// Postgres rejects the insert with a numeric field overflow — an opaque 500 instead of a
// clear 400 pointing at the offending field.
export const MAX_INCOME_AMOUNT = 999999999999.99;

// Self-contained custom validator (not shared with other modules' DTOs) that rejects a
// receivedAt more than `maxFutureDays` in the future. "Received" income should, by
// definition, already have happened — this mainly catches an accidental wrong-year typo
// (e.g. 2027 instead of 2026) before it silently skews "this month" and "all time"
// income aggregates used throughout Dashboard, Tax, and Retirement. A 1-day grace window
// absorbs timezone differences between the client's local date and the server's clock.
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
          return `receivedAt cannot be more than ${maxDays} day(s) in the future`;
        },
      },
    });
  };
}

export class CreateIncomeDto {
  @IsEnum(IncomeSource)
  source!: IncomeSource;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  label!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_INCOME_AMOUNT, { message: `amount cannot exceed ${MAX_INCOME_AMOUNT}` })
  amount!: number;

  @IsEnum(Recurrence)
  recurrence!: Recurrence;

  @IsDateString()
  @IsNotFarFutureDate(1)
  receivedAt!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
