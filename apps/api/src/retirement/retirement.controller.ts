import { Body, Controller, Get, Patch, UseGuards } from "@nestjs/common";
import { RetirementService } from "./retirement.service";
import { UpdateRetirementProfileDto } from "./dto/update-retirement-profile.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("retirement")
export class RetirementController {
  constructor(private retirementService: RetirementService) {}

  @Get("profile")
  getProfile(@CurrentUser() user: User) {
    return this.retirementService.getOrCreateProfile(user.id);
  }

  @Patch("profile")
  updateProfile(@CurrentUser() user: User, @Body() dto: UpdateRetirementProfileDto) {
    return this.retirementService.updateProfile(user.id, dto);
  }

  @Get("plan")
  plan(@CurrentUser() user: User) {
    return this.retirementService.computePlan(user.id);
  }
}
