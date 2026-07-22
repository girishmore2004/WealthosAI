import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { InvestmentsService } from "./investments.service";
import { CreateInvestmentDto } from "./dto/create-investment.dto";
import { UpdateInvestmentDto } from "./dto/update-investment.dto";
import { RebalancePortfolioDto } from "./dto/rebalance-portfolio.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("investments")
export class InvestmentsController {
  constructor(private investmentsService: InvestmentsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.investmentsService.list(user.id);
  }

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.investmentsService.summary(user.id);
  }

  @Post("rebalance")
  rebalance(@CurrentUser() user: User, @Body() dto: RebalancePortfolioDto) {
    return this.investmentsService.rebalance(user.id, dto);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateInvestmentDto) {
    return this.investmentsService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateInvestmentDto) {
    return this.investmentsService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.investmentsService.remove(user.id, id);
  }
}
