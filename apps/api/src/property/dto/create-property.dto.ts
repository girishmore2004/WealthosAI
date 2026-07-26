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
  Min,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from "class-validator";
import { Transform } from "class-transformer";
import { PropertyType } from "@wealthos/db";

// Property.currentValue and .purchasePrice are Decimal(14, 2) — 14 total digits, 2
// after the decimal, so the largest value either can hold is 999999999999.99. Same
// constant/reasoning as the equivalent guards already added to Income/Expenses/
// Investments/Loans/Insurance's DTOs.
export const MAX_PROPERTY_VALUE_AMOUNT = 999999999999.99;

// Property.monthlyRentalIncome, .annualMaintenanceCost, and .annualPropertyTax are a
// SEPARATE, SMALLER Decimal(12, 2) — 12 total digits, 2 after the decimal, so the
// largest value any of these three can hold is 9999999999.99. Using the larger
// MAX_PROPERTY_VALUE_AMOUNT constant here would still let a value through that
// Postgres would reject — the two limits are genuinely different and both need their
// own guard to actually prevent the numeric-overflow 500.
export const MAX_PROPERTY_ANCILLARY_AMOUNT = 9999999999.99;

// Self-contained custom validator, not shared with other modules' DTOs. Rejects a
// purchaseDate more than `maxFutureDays` in the future — same reasoning as
// CreateInvestmentDto's identical guard: you cannot have already purchased a property
// that hasn't happened yet. (Deliberately NOT applied to Loans' startDate, which has a
// different, non-retrospective semantic — see that DTO's own comment.)
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

export class CreatePropertyDto {
  @IsEnum(PropertyType)
  type!: PropertyType;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  name!: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(240)
  address?: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_PROPERTY_VALUE_AMOUNT, { message: `currentValue cannot exceed ${MAX_PROPERTY_VALUE_AMOUNT}` })
  currentValue!: number;

  @IsNumber()
  @IsPositive()
  @Max(MAX_PROPERTY_VALUE_AMOUNT, { message: `purchasePrice cannot exceed ${MAX_PROPERTY_VALUE_AMOUNT}` })
  purchasePrice!: number;

  @IsDateString()
  @IsNotFarFutureDate(1)
  purchaseDate!: string;

  @IsOptional()
  @IsBoolean()
  isRented?: boolean;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_PROPERTY_ANCILLARY_AMOUNT, { message: `monthlyRentalIncome cannot exceed ${MAX_PROPERTY_ANCILLARY_AMOUNT}` })
  monthlyRentalIncome?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_PROPERTY_ANCILLARY_AMOUNT, { message: `annualMaintenanceCost cannot exceed ${MAX_PROPERTY_ANCILLARY_AMOUNT}` })
  annualMaintenanceCost?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(MAX_PROPERTY_ANCILLARY_AMOUNT, { message: `annualPropertyTax cannot exceed ${MAX_PROPERTY_ANCILLARY_AMOUNT}` })
  annualPropertyTax?: number;

  @IsOptional()
  @IsString()
  loanId?: string;

  @IsOptional()
  @IsString()
  insurancePolicyId?: string;

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
