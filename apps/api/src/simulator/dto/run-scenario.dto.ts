import { IsEnum, IsObject } from "class-validator";
import { ScenarioType } from "@wealthos/db";

export class RunScenarioDto {
  @IsEnum(ScenarioType)
  scenarioType!: ScenarioType;

  // Shape depends on scenarioType (see ScenarioParamsByType in @wealthos/types).
  // SimulatorService.validateParams() checks the exact required fields per type and
  // throws a clear BadRequestException rather than letting a missing field silently
  // become NaN inside the pure engine.
  @IsObject()
  params!: Record<string, unknown>;
}
