import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { InvestmentProjectionService } from "./investment-projection.service";
import { InvestmentAnalyticsService } from "./investment-analytics.service";
import { PortfolioProjectionQueryDto, ProjectionQueryDto } from "./dto/projection-query.dto";
import { InvestmentAnalyticsQueryDto } from "./dto/analytics-query.dto";

// Shares the "investments" prefix. Every path here is a fixed word ("projection", "analytics") that no
// other controller in this module uses at the top level, and none collides with ":id/..." routes.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("investments")
export class InvestmentProjectionController {
  constructor(
    private projections: InvestmentProjectionService,
    private analytics: InvestmentAnalyticsService,
  ) {}

  // Stateless "what if": PROJECTED numbers from the assumptions in the query. Touches no data.
  @RateLimit(300, 3600)
  @Get("projection")
  calculate(@Query() q: ProjectionQueryDto) {
    return this.projections.calculate(q);
  }

  // Projects the caller's actual holdings and active schedules (PROJECTED), beside their ACTUAL value.
  @RateLimit(120, 3600)
  @Get("projection/portfolio")
  portfolio(@CurrentUser() user: User, @Query() q: PortfolioProjectionQueryDto) {
    return this.projections.portfolio(user.id, q);
  }

  // ACTUAL ledger-derived trends: contributions, portfolio value, gain/loss; plus planned vs actual.
  @RateLimit(120, 3600)
  @Get("analytics")
  trends(@CurrentUser() user: User, @Query() q: InvestmentAnalyticsQueryDto) {
    return this.analytics.analytics(user.id, q.months);
  }
}
