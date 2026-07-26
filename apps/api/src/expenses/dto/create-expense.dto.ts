import {
  IsBoolean,
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
import { PaymentMethod } from "@wealthos/db";

// Expense.amount is Decimal(14, 2) in the schema — 14 total digits, 2 after the decimal
// point, so the largest value the column can actually hold is 999999999999.99. Without
// this check, an amount above that limit passes DTO validation and only fails when
// Postgres rejects the insert with a numeric field overflow — an opaque 500 instead of a
// clear 400 pointing at the offending field. (Same reasoning as CreateIncomeDto's
// identical constant, kept local to this file rather than shared, since the two DTOs
// have no other coupling.)
export const MAX_EXPENSE_AMOUNT = 999999999999.99;

// Self-contained custom validator, not shared with other modules' DTOs. Rejects a
// spentAt more than `maxFutureDays` in the future — "spent" money should, by definition,
// already have been spent. Mainly catches an accidental wrong-year typo before it
// silently skews categoryBreakdown()'s "this month" totals and the subscription
// detector's 3-month lookback window. A 1-day grace window absorbs timezone differences
// between the client's local date and the server's clock.
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
          return `spentAt cannot be more than ${maxDays} day(s) in the future`;
        },
      },
    });
  };
}

export class CreateExpenseDto {
  @IsString()
  categoryId!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  merchant?: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_EXPENSE_AMOUNT, { message: `amount cannot exceed ${MAX_EXPENSE_AMOUNT}` })
  amount!: number;

  @IsDateString()
  @IsNotFarFutureDate(1)
  spentAt!: string;

  @IsEnum(PaymentMethod)
  paymentMethod!: PaymentMethod;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
