import { IsArray, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class BuildScenarioStudioDto {
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  prompt!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  targetGoalIds?: string[];
}
