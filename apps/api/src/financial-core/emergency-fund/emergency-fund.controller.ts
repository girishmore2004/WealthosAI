import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { EmergencyFundService } from "./emergency-fund.service";
import { CreateEmergencyEntryDto } from "./dto/create-emergency-entry.dto";
import { UpdateEmergencyPlanDto, UseEmergencyMoneyDto } from "./dto/emergency-plan.dto";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("emergency-fund")
export class EmergencyFundController {
  constructor(private service: EmergencyFundService) {}

  @RateLimit(120, 3600)
  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.service.summary(user.id);
  }

  // Everything the Emergency Fund page / dashboard card needs in one response: balance, coverage,
  // target, progress, contribution plan, totals, last activity and a 12-month trend.
  @RateLimit(120, 3600)
  @Get("overview")
  overview(@CurrentUser() user: User) {
    return this.service.overview(user.id);
  }

  // The history, newest first, each row with the balance AFTER it.
  @RateLimit(120, 3600)
  @Get("ledger")
  ledger(@CurrentUser() user: User) {
    return this.service.ledger(user.id);
  }

  // Target (an amount OR months of essential expenses) and the contribution plan.
  @RateLimit(60, 3600)
  @Put("plan")
  updatePlan(@CurrentUser() user: User, @Body() dto: UpdateEmergencyPlanDto) {
    return this.service.updatePlan(user.id, dto);
  }

  // USE MONEY: a withdrawal from the reserve, optionally with the genuine Expense it paid for,
  // recorded together in one transaction.
  @RateLimit(60, 3600)
  @Post("use")
  use(@CurrentUser() user: User, @Body() dto: UseEmergencyMoneyDto) {
    return this.service.useMoney(user.id, dto);
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
