import { Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { AlertsService } from "./alerts.service";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("alerts")
export class AlertsController {
  constructor(private alertsService: AlertsService) {}

  @Get()
  list(@CurrentUser() user: User, @Query("unreadOnly") unreadOnly?: string) {
    return this.alertsService.list(user.id, unreadOnly === "true");
  }

  @Post("refresh")
  refresh(@CurrentUser() user: User) {
    return this.alertsService.refresh(user.id);
  }

  @Patch(":id/read")
  markRead(@CurrentUser() user: User, @Param("id") id: string) {
    return this.alertsService.markRead(user.id, id);
  }

  @Delete(":id")
  dismiss(@CurrentUser() user: User, @Param("id") id: string) {
    return this.alertsService.dismiss(user.id, id);
  }
}
