import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { MlInsightsService } from "./ml-insights.service";

// UPDATED (Phase 14.1 — advanced probabilistic models): `summary` now does have one
// AiGatewayService call in its dependency chain — AnomalyExplanationService, which
// composes a natural-language "likely cause" narrative for flagged anomalies (see
// explanation/anomaly-explanation.service.ts). That call is marked `cacheable: true`
// (same facts → same explanation, so a dashboard reload with unchanged anomalies
// costs no additional Groq quota) and always falls back to a deterministic,
// rule-based narrative if the model is unavailable or fails grounding verification —
// `summary` itself never throws because of it. Every OTHER model behind this
// controller remains synchronous, deterministic-given-its-inputs statistical
// computation (OLS regression, Bayesian updating, MAD/z-scores, PSI, Welch's z-test).
// The rate limit on `summary` is lowered from the fully-deterministic-era 60/hour to
// 30/hour to reflect the new (cached, fallback-safe, but real) Groq dependency;
// `history` stays at 60/hour since it only ever reads back already-computed rows.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("ml-insights")
export class MlInsightsController {
  constructor(private mlInsights: MlInsightsService) {}

  @Get("summary")
  @RateLimit(30, 3600)
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
