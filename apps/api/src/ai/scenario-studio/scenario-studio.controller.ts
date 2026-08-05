import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { ScenarioStudioService } from "./scenario-studio.service";
import { BuildScenarioStudioDto } from "./dto/build-scenario-studio.dto";
import { SimulateScenarioStudioDto } from "./dto/simulate-scenario-studio.dto";
import { OptimizeScenarioStudioDto } from "./dto/optimize-scenario-studio.dto";

// Building a full scenario family is expensive relative to a normal CRUD route (up to
// ~10 SimulatorService.run() calls for the 4 variants + sensitivity sweep, plus a
// Monte Carlo preview and 2 AI gateway calls for parsing and explanation) — rate-
// limited more tightly than most other AI routes as a result. /simulate is cheaper
// (one Monte Carlo run, one AI gateway call) but still a real compute cost (up to
// 5,000 simulated trajectories); /optimize is the most expensive route in this
// module (up to OPTIMIZATION_COARSE_STEPS + OPTIMIZATION_FINE_STEPS reduced-fidelity
// Monte Carlo runs during search, plus one full-fidelity run and one AI gateway
// call), so it gets the tightest limit of the three.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("scenario-studio")
export class ScenarioStudioController {
  constructor(private studio: ScenarioStudioService) {}

  @Post("build")
  @RateLimit(10, 3600)
  async build(@CurrentUser() user: User, @Body() dto: BuildScenarioStudioDto) {
    return this.studio.build(user.id, dto.prompt, dto.targetGoalIds ?? []);
  }

  // Probabilistic planning: Monte Carlo simulation for a single scenario type +
  // params, returning percentile outputs (p10/p25/p50/p75/p90), a risk level, and a
  // grounded explanation — see MonteCarloSimulationService and
  // scenario-studio.constants.ts's DEFAULT_MC_ASSUMPTIONS for the modeled
  // distributions.
  @Post("simulate")
  @RateLimit(15, 3600)
  async simulate(@CurrentUser() user: User, @Body() dto: SimulateScenarioStudioDto) {
    return this.studio.simulate(user.id, dto);
  }

  // Constraint-solving recommendation: searches for the optimal scenario parameter
  // value subject to budget/tax/retirement/goal constraints — see
  // ScenarioOptimizerService and OPTIMIZABLE_SCENARIO_TYPES for which scenario types
  // support this.
  @Post("optimize")
  @RateLimit(5, 3600)
  async optimize(@CurrentUser() user: User, @Body() dto: OptimizeScenarioStudioDto) {
    return this.studio.optimize(user.id, dto);
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.studio.history(user.id, limit);
  }

  @Get("history/simulations")
  @RateLimit(60, 3600)
  async simulationHistory(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.studio.monteCarloHistory(user.id, limit);
  }

  @Get("history/optimizations")
  @RateLimit(60, 3600)
  async optimizationHistory(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.studio.optimizationHistory(user.id, limit);
  }
}
