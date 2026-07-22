import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { HouseholdService } from "./household.service";
import { CreateMemberDto } from "./dto/create-member.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("household")
export class HouseholdController {
  constructor(private householdService: HouseholdService) {}

  @Get()
  get(@CurrentUser() user: User) {
    return this.householdService.getOrCreateHouseholdForUser(user.id);
  }

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.householdService.getHouseholdSummary(user.id);
  }

  @Post("dependents")
  addDependent(@CurrentUser() user: User, @Body() dto: CreateMemberDto) {
    return this.householdService.addDependent(user.id, dto);
  }

  @Delete("dependents/:id")
  removeDependent(@CurrentUser() user: User, @Param("id") id: string) {
    return this.householdService.removeDependent(user.id, id);
  }
}
