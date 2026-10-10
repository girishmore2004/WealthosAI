import { Body, Controller, Delete, Get, Param, Put, UseGuards } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";
import { DashboardOverviewService } from "./dashboard-overview.service";
import { UpsertBudgetDto } from "./dto/upsert-budget.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("dashboard")
export class DashboardController {
  constructor(
    private dashboardService: DashboardService,
    private overviewService: DashboardOverviewService,
  ) {}

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.dashboardService.getSummary(user.id);
  }

  // Batch 8: the money-flow dashboard (ACTUAL basis only) - see DashboardOverviewService.
  @Get("overview")
  overview(@CurrentUser() user: User) {
    return this.overviewService.overview(user.id);
  }

  // NEW: closes the audit's top-priority-flagged gap — real, user-defined budgets now
  // back the health score's budgetAdherence dimension instead of a hardcoded
  // placeholder. PUT (not POST), since setting a category's budget is a genuine
  // upsert — idempotent by (userId, categoryId).
  @Get("budgets")
  listBudgets(@CurrentUser() user: User) {
    return this.dashboardService.listBudgets(user.id);
  }

  @Put("budgets")
  upsertBudget(@CurrentUser() user: User, @Body() dto: UpsertBudgetDto) {
    return this.dashboardService.upsertBudget(user.id, dto);
  }

  @Delete("budgets/:id")
  removeBudget(@CurrentUser() user: User, @Param("id") id: string) {
    return this.dashboardService.removeBudget(user.id, id);
  }
}
