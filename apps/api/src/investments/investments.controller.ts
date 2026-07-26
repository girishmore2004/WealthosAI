import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { InvestmentsService } from "./investments.service";
import { CreateInvestmentDto } from "./dto/create-investment.dto";
import { UpdateInvestmentDto } from "./dto/update-investment.dto";
import { RebalancePortfolioDto } from "./dto/rebalance-portfolio.dto";
import { ListInvestmentsQueryDto } from "./dto/list-investments-query.dto";
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

  // Opt-in paginated + type-filterable listing. Existing GET /investments above is left
  // exactly as-is (unbounded array response) since the current Investments page consumes
  // it directly as an array — same convention as Income/Expenses' equivalent endpoints.
  @Get("paged")
  listPaged(@CurrentUser() user: User, @Query() query: ListInvestmentsQueryDto) {
    return this.investmentsService.listPaged(user.id, query);
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
