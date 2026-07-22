import { IsDateString, IsEnum, IsNumber, IsOptional, IsPositive, IsString, Min, MaxLength } from "class-validator";
import { GoalType } from "@wealthos/db";

export class CreateGoalDto {
  @IsEnum(GoalType)
  type!: GoalType;

  @IsString()
  @MaxLength(120)
  name!: string;

  @IsNumber()
  @IsPositive()
  targetAmount!: number;

  @IsDateString()
  targetDate!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  currentAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyContribution?: number;
}
