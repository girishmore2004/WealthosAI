import { Controller, Get, UseGuards } from "@nestjs/common";
import { DashboardService } from "./dashboard.service";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("dashboard")
export class DashboardController {
  constructor(private dashboardService: DashboardService) {}

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.dashboardService.getSummary(user.id);
  }
}
