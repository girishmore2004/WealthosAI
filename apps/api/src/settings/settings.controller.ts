import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { SettingsService } from "./settings.service";
import { UpdateSettingsDto } from "./dto/update-settings.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("settings")
export class SettingsController {
  constructor(private settingsService: SettingsService) {}

  @Get()
  get(@CurrentUser() user: User) {
    return this.settingsService.getOrCreate(user.id);
  }

  @Patch()
  update(@CurrentUser() user: User, @Body() dto: UpdateSettingsDto) {
    return this.settingsService.update(user.id, dto);
  }
}
