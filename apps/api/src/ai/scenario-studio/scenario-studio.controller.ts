import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { ScenarioStudioService } from "./scenario-studio.service";
import { BuildScenarioStudioDto } from "./dto/build-scenario-studio.dto";

// Building a full scenario family is expensive relative to a normal CRUD route (up to
// ~10 SimulatorService.run() calls for the 4 variants + sensitivity sweep, plus 2 AI
// gateway calls for parsing and explanation) — rate-limited more tightly than most
// other AI routes as a result.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("scenario-studio")
export class ScenarioStudioController {
  constructor(private studio: ScenarioStudioService) {}

  @Post("build")
  @RateLimit(10, 3600)
  async build(@CurrentUser() user: User, @Body() dto: BuildScenarioStudioDto) {
    return this.studio.build(user.id, dto.prompt, dto.targetGoalIds ?? []);
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.studio.history(user.id, limit);
  }
}
