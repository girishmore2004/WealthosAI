import {
  IsDateString,
  IsEnum,
  IsInt,
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
import { LoanType } from "@wealthos/db";

// Loan.principal, .outstandingPrincipal, and .emiAmount are all Decimal(14, 2) in the
// schema — 14 total digits, 2 after the decimal point, so the largest value any of them
// can actually hold is 999999999999.99. Without this check, a value above that limit
// passes DTO validation and only fails when Postgres rejects the insert with a numeric
// field overflow — an opaque 500 instead of a clear 400. (Same constant/reasoning as the
// equivalent guards already added to Income/Expenses/Investments' DTOs.)
export const MAX_LOAN_AMOUNT = 999999999999.99;

// Matches computeSchedule()'s own 600-month (50-year) safety cap in loans.service.ts.
// A loan created with a longer stated tenure than the engine will ever actually simulate
// would silently have its amortization schedule truncated/misrepresented without this
// guard — better to reject an unrealistic tenure at creation than produce a schedule
// that quietly stops short of the loan's claimed length.
export const MAX_TENURE_MONTHS = 600;

// Cross-field check: a loan's outstanding balance cannot exceed its original principal —
// self-contained in this file (not shared with other modules' DTOs), applied to
// `outstandingPrincipal` but reading `principal` off the same object via
// ValidationArguments.
function IsLessThanOrEqualToPrincipal(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isLessThanOrEqualToPrincipal",
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const principal = (args.object as { principal?: unknown }).principal;
          if (typeof value !== "number" || typeof principal !== "number") return true; // let @IsNumber report type errors
          return value <= principal;
        },
        defaultMessage() {
          return "outstandingPrincipal cannot exceed principal";
        },
      },
    });
  };
}

export class CreateLoanDto {
  @IsEnum(LoanType)
  type!: LoanType;

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(120)
  lender!: string;

  @IsNumber()
  @IsPositive()
  @Max(MAX_LOAN_AMOUNT, { message: `principal cannot exceed ${MAX_LOAN_AMOUNT}` })
  principal!: number;

  @IsNumber()
  @IsPositive()
  @Max(MAX_LOAN_AMOUNT, { message: `outstandingPrincipal cannot exceed ${MAX_LOAN_AMOUNT}` })
  @IsLessThanOrEqualToPrincipal()
  outstandingPrincipal!: number;

  @IsNumber()
  @Min(0)
  @Max(50)
  interestRateAnnual!: number;

  @IsInt()
  @IsPositive()
  @Max(MAX_TENURE_MONTHS, { message: `tenureMonths cannot exceed ${MAX_TENURE_MONTHS} (50 years)` })
  tenureMonths!: number;

  @IsNumber()
  @IsPositive()
  @Max(MAX_LOAN_AMOUNT, { message: `emiAmount cannot exceed ${MAX_LOAN_AMOUNT}` })
  emiAmount!: number;

  @IsDateString()
  startDate!: string;

  // Deliberately NOT given a far-future-date guard (unlike Income's receivedAt,
  // Expenses' spentAt, or Investments' purchaseDate) — those are inherently
  // retrospective ("received", "spent", "purchased"), but a loan's startDate can
  // legitimately be a near-future date (e.g. logging an approved loan ahead of its
  // actual disbursement), so the same guard would reject a genuinely valid entry here.

  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
