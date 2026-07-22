import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { AgenticCoachService } from "./agentic-coach.service";
import { AskV2Dto } from "./dto/ask-v2.dto";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("coach/v2")
export class AgenticCoachController {
  constructor(private agenticCoach: AgenticCoachService) {}

  @Post("ask")
  @RateLimit(20, 3600)
  async ask(@CurrentUser() user: User, @Body() dto: AskV2Dto) {
    return this.agenticCoach.ask(user.id, dto.question);
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.agenticCoach.history(user.id, limit);
  }
}
