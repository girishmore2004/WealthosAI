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
import { BusinessTransactionType } from "@wealthos/db";

// BusinessTransaction.amount is Decimal(14, 2) in the schema — 14 total digits, 2 after
// the decimal point, so the largest value it can hold is 999999999999.99. Same
// constant/reasoning as the equivalent guards already added across every other money
// module's DTOs this session.
export const MAX_TRANSACTION_AMOUNT = 999999999999.99;

// Self-contained custom validator, not shared with other modules' DTOs. Rejects an
// occurredAt more than `maxFutureDays` in the future — a transaction that already
// "occurred" is, by definition, retrospective (same reasoning as Income's receivedAt /
// Expenses' spentAt). A 1-day grace window absorbs timezone differences between the
// client's local date and the server's clock.
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
          return `occurredAt cannot be more than ${maxDays} day(s) in the future`;
        },
      },
    });
  };
}

export class CreateTransactionDto {
  @IsEnum(BusinessTransactionType)
  type!: BusinessTransactionType;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(80)
  category?: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_TRANSACTION_AMOUNT, { message: `amount cannot exceed ${MAX_TRANSACTION_AMOUNT}` })
  amount!: number;

  @IsDateString()
  @IsNotFarFutureDate(1)
  occurredAt!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  isRecurring?: boolean;
}
