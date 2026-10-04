import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { EmergencyFundService } from "./emergency-fund.service";
import { CreateEmergencyEntryDto } from "./dto/create-emergency-entry.dto";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("emergency-fund")
export class EmergencyFundController {
  constructor(private service: EmergencyFundService) {}

  @RateLimit(120, 3600)
  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.service.summary(user.id);
  }

  @RateLimit(120, 3600)
  @Get("entries")
  list(@CurrentUser() user: User) {
    return this.service.list(user.id);
  }

  @RateLimit(120, 3600)
  @Post("entries")
  create(@CurrentUser() user: User, @Body() dto: CreateEmergencyEntryDto) {
    return this.service.create(user.id, dto);
  }

  @RateLimit(120, 3600)
  @Delete("entries/:id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.remove(user.id, id);
  }
}
