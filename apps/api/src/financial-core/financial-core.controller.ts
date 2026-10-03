import { Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { DataHealthService } from "./data-health/data-health.service";
import { LegacyMigrationService } from "./legacy-migration/legacy-migration.service";

// One authoritative read surface for the frontend: instead of calling several independent
// endpoints that each recompute cash/net worth, pages read these. The userId always comes
// from the authenticated session — never from the request.
@UseGuards(SessionAuthGuard)
@Controller("financial-core")
export class FinancialCoreController {
  constructor(
    private facts: FinancialFactsService,
    private dataHealth: DataHealthService,
    private migration: LegacyMigrationService,
  ) {}

  @Get("position")
  position(@CurrentUser() user: User) {
    return this.facts.getFinancialPosition(user.id);
  }

  @Get("cash-flow")
  cashFlow(@CurrentUser() user: User, @Query("month") month?: string) {
    return this.facts.getMonthlyCashFlow(user.id, month);
  }

  @Get("emergency-coverage")
  coverage(@CurrentUser() user: User) {
    return this.facts.getEmergencyCoverage(user.id);
  }

  @Get("data-health")
  health(@CurrentUser() user: User) {
    return this.dataHealth.getReport(user.id);
  }

  // Preview by default. Pass ?dryRun=false to actually migrate — an explicit opt-in so the
  // legacy data is never rewritten by accident.
  @Post("migration/legacy")
  migrate(@CurrentUser() user: User, @Query("dryRun") dryRun?: string) {
    return this.migration.run(user.id, dryRun !== "false");
  }
}
