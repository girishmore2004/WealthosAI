import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { InvestmentLedgerService } from "./investment-ledger.service";
import { CreateCashflowDto } from "./dto/create-cashflow.dto";
import { CreateValuationDto } from "./dto/create-valuation.dto";
import { SipScheduleDto } from "./dto/sip-schedule.dto";
import { UpdateCashflowDto } from "./dto/update-cashflow.dto";
import { SipInstallmentDto } from "./dto/sip-installment.dto";
import { ListTransactionsQueryDto } from "./dto/list-transactions-query.dto";
import { InvestmentPortfolioService } from "./investment-portfolio.service";

// Shares the "investments" prefix with InvestmentsController; every path here is distinct
// from that controller's (":id/..." sub-resources and "sip/generate"), so no existing route
// is shadowed.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("investments")
export class InvestmentLedgerController {
  constructor(
    private ledger: InvestmentLedgerService,
    private portfolio: InvestmentPortfolioService,
  ) {}

  // The canonical portfolio summary: the same figures the Home dashboard shows. Declared before every
  // ":id/..." route so "portfolio" and "transactions" are never read as an investment id.
  @RateLimit(300, 3600)
  @Get("portfolio")
  portfolioSummary(@CurrentUser() user: User) {
    return this.portfolio.portfolio(user.id);
  }

  @RateLimit(300, 3600)
  @Get("transactions")
  transactions(@CurrentUser() user: User, @Query() query: ListTransactionsQueryDto) {
    return this.ledger.listTransactions(user.id, query);
  }

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
  @Patch(":id/cashflows/:cashflowId")
  updateCashflow(@CurrentUser() user: User, @Param("id") id: string, @Param("cashflowId") cashflowId: string, @Body() dto: UpdateCashflowDto) {
    return this.ledger.updateCashflow(user.id, id, cashflowId, dto);
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

  // The schedule with its derived figures: next date, monthly / annual equivalents, planned vs due
  // vs remaining contributions, and what has actually been recorded.
  @RateLimit(300, 3600)
  @Get(":id/sip-schedule")
  schedule(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.getSipSchedule(user.id, id);
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

  @RateLimit(60, 3600)
  @Post(":id/sip/pause")
  pause(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.pauseSip(user.id, id);
  }

  @RateLimit(60, 3600)
  @Post(":id/sip/resume")
  resume(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.resumeSip(user.id, id);
  }

  @RateLimit(60, 3600)
  @Post(":id/sip/cancel")
  cancel(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.cancelSip(user.id, id);
  }

  @RateLimit(300, 3600)
  @Get(":id/sip/installments")
  installments(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.listSipInstallments(user.id, id);
  }

  @RateLimit(120, 3600)
  @Post(":id/sip/installments")
  recordInstallment(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: SipInstallmentDto) {
    return this.ledger.recordSipInstallment(user.id, id, dto);
  }

  @RateLimit(300, 3600)
  @Get(":id/sip/changes")
  changes(@CurrentUser() user: User, @Param("id") id: string) {
    return this.ledger.listSipChanges(user.id, id);
  }
}
