import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { HouseholdService } from "./household.service";
import { CreateMemberDto } from "./dto/create-member.dto";
import { CreateInviteDto } from "./dto/create-invite.dto";
import { RespondToInviteDto } from "./dto/respond-to-invite.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
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

  // NEW: closes the audit-flagged "no invite/join flow" gap. Rate-limited (reusing the
  // shared, feature-agnostic RateLimitGuard already used elsewhere in the app, e.g. the
  // AI health self-test) to prevent invite-spam abuse — 10 invites/hour per requesting
  // user is generous for legitimate household-building use while bounding worst-case
  // spam volume.
  @UseGuards(RateLimitGuard)
  @RateLimit(10, 3600)
  @Post("invites")
  createInvite(@CurrentUser() user: User, @Body() dto: CreateInviteDto) {
    return this.householdService.createInvite(user.id, dto);
  }

  @Get("invites")
  listInvites(@CurrentUser() user: User) {
    return this.householdService.listInvites(user.id);
  }

  @Delete("invites/:id")
  revokeInvite(@CurrentUser() user: User, @Param("id") id: string) {
    return this.householdService.revokeInvite(user.id, id);
  }

  @Post("invites/accept")
  acceptInvite(@CurrentUser() user: User, @Body() dto: RespondToInviteDto) {
    return this.householdService.acceptInvite(user.id, dto);
  }

  @Post("invites/decline")
  declineInvite(@CurrentUser() user: User, @Body() dto: RespondToInviteDto) {
    return this.householdService.declineInvite(user.id, dto);
  }

  @Post("leave")
  leave(@CurrentUser() user: User) {
    return this.householdService.leaveHousehold(user.id);
  }
}
