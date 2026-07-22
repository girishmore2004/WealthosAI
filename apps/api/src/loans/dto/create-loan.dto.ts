import { IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsPositive, IsString, Max, MaxLength, Min } from "class-validator";
import { LoanType } from "@wealthos/db";

export class CreateLoanDto {
  @IsEnum(LoanType)
  type!: LoanType;

  @IsString()
  @MaxLength(120)
  lender!: string;

  @IsNumber()
  @IsPositive()
  principal!: number;

  @IsNumber()
  @IsPositive()
  outstandingPrincipal!: number;

  @IsNumber()
  @Min(0)
  @Max(50)
  interestRateAnnual!: number;

  @IsInt()
  @IsPositive()
  tenureMonths!: number;

  @IsNumber()
  @IsPositive()
  emiAmount!: number;

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsString()
  notes?: string;
}
