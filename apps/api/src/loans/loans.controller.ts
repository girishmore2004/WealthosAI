import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { LoansService } from "./loans.service";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";
import { PrepaymentQueryDto } from "./dto/prepayment-query.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("loans")
export class LoansController {
  constructor(private loansService: LoansService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.loansService.list(user.id);
  }

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.loansService.debtSummary(user.id);
  }

  @Get("payoff-order")
  payoffOrder(@CurrentUser() user: User, @Query("strategy") strategy: "snowball" | "avalanche" = "avalanche") {
    return this.loansService.payoffOrder(user.id, strategy);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateLoanDto) {
    return this.loansService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateLoanDto) {
    return this.loansService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.loansService.remove(user.id, id);
  }

  @Get(":id/amortization")
  amortization(@CurrentUser() user: User, @Param("id") id: string) {
    return this.loansService.amortizationSchedule(user.id, id);
  }

  @Get(":id/prepayment-impact")
  prepaymentImpact(@CurrentUser() user: User, @Param("id") id: string, @Query() query: PrepaymentQueryDto) {
    return this.loansService.prepaymentImpact(user.id, id, query.lumpSum);
  }
}
