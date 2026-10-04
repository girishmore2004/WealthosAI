import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { InsuranceService } from "./insurance.service";
import { InsurancePremiumService } from "./insurance-premium.service";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { RecordPremiumDto } from "./dto/record-premium.dto";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("insurance")
export class InsuranceController {
  constructor(
    private insuranceService: InsuranceService,
    private premiumService: InsurancePremiumService,
  ) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.insuranceService.list(user.id);
  }

  @Get("gap-analysis")
  gapAnalysis(@CurrentUser() user: User) {
    return this.insuranceService.gapAnalysis(user.id);
  }

  @Get("renewals")
  renewals(@CurrentUser() user: User, @Query("withinDays") withinDays?: string) {
    return this.insuranceService.upcomingRenewals(user.id, withinDays ? parseInt(withinDays, 10) : undefined);
  }

  // NEW: premium per policy + total recorded, from the linked expenses.
  @RateLimit(120, 3600)
  @Get("premiums/summary")
  premiumSummary(@CurrentUser() user: User) {
    return this.premiumService.totals(user.id);
  }

  // NEW: the single, idempotent way to record a premium payment (manual or generated).
  @RateLimit(60, 3600)
  @Post(":id/premiums")
  recordPremium(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: RecordPremiumDto) {
    return this.premiumService.recordPremium(user.id, id, dto);
  }

  @Get("nominee-summary")
  nomineeSummary(@CurrentUser() user: User) {
    return this.insuranceService.nomineeSummary(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreatePolicyDto) {
    return this.insuranceService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdatePolicyDto) {
    return this.insuranceService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.insuranceService.remove(user.id, id);
  }
}
