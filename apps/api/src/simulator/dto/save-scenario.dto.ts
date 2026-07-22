import { IsEnum, IsObject, IsString, MaxLength } from "class-validator";
import { ScenarioType } from "@wealthos/db";

export class SaveScenarioDto {
  @IsEnum(ScenarioType)
  scenarioType!: ScenarioType;

  @IsString()
  @MaxLength(120)
  label!: string;

  @IsObject()
  params!: Record<string, unknown>;
}
