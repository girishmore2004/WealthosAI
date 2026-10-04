import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { InvestmentLedgerService } from "./investment-ledger.service";
import { CreateCashflowDto } from "./dto/create-cashflow.dto";
import { CreateValuationDto } from "./dto/create-valuation.dto";
import { SipScheduleDto } from "./dto/sip-schedule.dto";

// Shares the "investments" prefix with InvestmentsController; every path here is distinct
// from that controller's (":id/..." sub-resources and "sip/generate"), so no existing route
// is shadowed.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("investments")
export class InvestmentLedgerController {
  constructor(private ledger: InvestmentLedgerService) {}

  @RateLimit(30, 3600)
  @Post("sip/generate")
  generateAll(@CurrentUser() user: User) {
    return this.ledger.generateAllDueSipContributions(user.id);
  }

  @RateLimit(300, 3600)
  @Get(":id/metrics")
  metrics(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.metrics(user.id, id);
  }

  @RateLimit(300, 3600)
  @Get(":id/cashflows")
  listCashflows(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.listCashflows(user.id, id);
  }

  @RateLimit(300, 3600)
  @Post(":id/cashflows")
  addCashflow(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: CreateCashflowDto) {
    return this.ledger.addCashflow(user.id, id, dto);
  }

  @RateLimit(300, 3600)
  @Delete(":id/cashflows/:cashflowId")
  removeCashflow(@CurrentUser() user: User, @Param("id") id: string, @Param("cashflowId") cashflowId: string) {
    return this.ledger.removeCashflow(user.id, id, cashflowId);
  }

  @RateLimit(300, 3600)
  @Get(":id/valuations")
  listValuations(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.listValuations(user.id, id);
  }

  @RateLimit(300, 3600)
  @Post(":id/valuations")
  addValuation(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: CreateValuationDto) {
    return this.ledger.addValuation(user.id, id, dto);
  }

  @RateLimit(300, 3600)
  @Put(":id/sip-schedule")
  setSchedule(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: SipScheduleDto) {
    return this.ledger.setSipSchedule(user.id, id, dto);
  }

  @RateLimit(30, 3600)
  @Post(":id/sip/generate")
  generate(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.generateSipContributions(user.id, id);
  }
}
