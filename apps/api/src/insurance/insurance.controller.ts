import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { InsuranceService } from "./insurance.service";
import { CreatePolicyDto } from "./dto/create-policy.dto";
import { UpdatePolicyDto } from "./dto/update-policy.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("insurance")
export class InsuranceController {
  constructor(private insuranceService: InsuranceService) {}

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
