import { Body, Controller, Delete, Get, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { GoalFundingService } from "./goal-funding.service";
import { GoalFundEntryDto, ReallocateGoalMoneyDto, UpdateGoalPlanDto, UseGoalMoneyDto } from "./dto/goal-fund.dto";

// Money → Goals: the detailed funding experience for every goal (the emergency reserve included).
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("goal-funds")
export class GoalFundingController {
  constructor(private service: GoalFundingService) {}

  // Every goal with its funding summary — the selector. `archived=true` also lists archived goals.
  @RateLimit(120, 3600)
  @Get()
  list(@CurrentUser() user: User, @Query("archived") archived?: string) {
    return this.service.listFunds(user.id, { includeArchived: archived === "true" });
  }

  @RateLimit(120, 3600)
  @Get(":goalId/overview")
  overview(@CurrentUser() user: User, @Param("goalId") goalId: string) {
    return this.service.overview(user.id, goalId);
  }

  @RateLimit(120, 3600)
  @Get(":goalId/ledger")
  ledger(@CurrentUser() user: User, @Param("goalId") goalId: string) {
    return this.service.ledger(user.id, goalId);
  }

  @RateLimit(120, 3600)
  @Post(":goalId/entries")
  addEntry(@CurrentUser() user: User, @Param("goalId") goalId: string, @Body() dto: GoalFundEntryDto) {
    return this.service.addEntry(user.id, goalId, dto);
  }

  @RateLimit(60, 3600)
  @Post(":goalId/use")
  use(@CurrentUser() user: User, @Param("goalId") goalId: string, @Body() dto: UseGoalMoneyDto) {
    return this.service.useMoney(user.id, goalId, dto);
  }

  @RateLimit(60, 3600)
  @Post(":goalId/reallocate")
  reallocate(@CurrentUser() user: User, @Param("goalId") goalId: string, @Body() dto: ReallocateGoalMoneyDto) {
    return this.service.reallocate(user.id, goalId, dto);
  }

  @RateLimit(60, 3600)
  @Put(":goalId/plan")
  updatePlan(@CurrentUser() user: User, @Param("goalId") goalId: string, @Body() dto: UpdateGoalPlanDto) {
    return this.service.updatePlan(user.id, goalId, dto);
  }

  @RateLimit(120, 3600)
  @Delete(":goalId/entries/:entryId")
  removeEntry(@CurrentUser() user: User, @Param("goalId") goalId: string, @Param("entryId") entryId: string) {
    return this.service.removeEntry(user.id, goalId, entryId);
  }
}
