import { Body, Controller, Delete, Get, Patch, UseGuards } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("users/me")
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Patch()
  updateProfile(@CurrentUser() user: User, @Body() dto: UpdateProfileDto) {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Get("export")
  exportData(@CurrentUser() user: User) {
    return this.usersService.exportData(user.id);
  }

  @Delete()
  deleteAccount(@CurrentUser() user: User) {
    return this.usersService.deleteAccount(user.id);
  }
}
