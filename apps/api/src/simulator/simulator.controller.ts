import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { SimulatorService } from "./simulator.service";
import { RunScenarioDto } from "./dto/run-scenario.dto";
import { SaveScenarioDto } from "./dto/save-scenario.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("simulator")
export class SimulatorController {
  constructor(private simulatorService: SimulatorService) {}

  @Post("run")
  run(@CurrentUser() user: User, @Body() dto: RunScenarioDto) {
    return this.simulatorService.run(user.id, dto.scenarioType, dto.params);
  }

  @Post("save")
  save(@CurrentUser() user: User, @Body() dto: SaveScenarioDto) {
    return this.simulatorService.save(user.id, dto.scenarioType, dto.params, dto.label);
  }

  @Get("saved")
  listSaved(@CurrentUser() user: User) {
    return this.simulatorService.listSaved(user.id);
  }

  @Get("compare")
  compare(@CurrentUser() user: User, @Query("ids") ids: string) {
    return this.simulatorService.compare(user.id, ids ? ids.split(",") : []);
  }

  @Delete("saved/:id")
  removeSaved(@CurrentUser() user: User, @Param("id") id: string) {
    return this.simulatorService.removeSaved(user.id, id);
  }
}
