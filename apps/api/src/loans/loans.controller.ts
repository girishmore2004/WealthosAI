import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { LoansService } from "./loans.service";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";
import { PrepaymentQueryDto } from "./dto/prepayment-query.dto";
import { SimulateAmortizationDto } from "./dto/simulate-amortization.dto";
import { SimulatePrepaymentImpactDto } from "./dto/simulate-prepayment-impact.dto";
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

  // NEW: floating-rate / combined rate-change + prepayment "what-if" simulation. A POST
  // (not GET) since the request body carries a nested array of rate-change objects,
  // which doesn't map cleanly onto query-string parameters the way the existing
  // single-value lumpSum query param does. Existing GET :id/amortization above is
  // completely untouched.
  @Post(":id/amortization/simulate")
  simulateAmortization(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: SimulateAmortizationDto) {
    return this.loansService.simulateAmortization(user.id, id, dto);
  }

  @Get(":id/prepayment-impact")
  prepaymentImpact(@CurrentUser() user: User, @Param("id") id: string, @Query() query: PrepaymentQueryDto) {
    return this.loansService.prepaymentImpact(user.id, id, query.lumpSum);
  }

  // NEW: same summary shape as the existing GET prepayment-impact above, but with an
  // optional future rate-change path applied to both the baseline and with-prepayment
  // schedules — answers "does prepaying still help if my rate also changes."
  @Post(":id/prepayment-impact/simulate")
  simulatePrepaymentImpact(
    @CurrentUser() user: User,
    @Param("id") id: string,
    @Body() dto: SimulatePrepaymentImpactDto,
  ) {
    return this.loansService.prepaymentImpact(user.id, id, dto.lumpSum, dto.rateChanges ?? []);
  }
}
