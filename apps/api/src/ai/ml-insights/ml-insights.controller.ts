import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { MlInsightsService } from "./ml-insights.service";

// No AiGatewayService involvement anywhere in this controller's dependency chain —
// every model behind it is synchronous, deterministic-given-its-inputs statistical
// computation, so there's no Groq quota concern and the rate limit here is generous
// compared to the AI-gateway-backed routes elsewhere in apps/api/src/ai/.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("ml-insights")
export class MlInsightsController {
  constructor(private mlInsights: MlInsightsService) {}

  @Get("summary")
  @RateLimit(60, 3600)
  async summary(@CurrentUser() user: User) {
    return this.mlInsights.summary(user.id);
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.mlInsights.history(user.id, limit);
  }
}
