import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { CoachService } from "./coach.service";
import { AskCoachDto } from "./dto/ask-coach.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("coach")
export class CoachController {
  constructor(private coachService: CoachService) {}

  @Post("ask")
  ask(@CurrentUser() user: User, @Body() dto: AskCoachDto) {
    return this.coachService.ask(user.id, dto.question);
  }

  @Get("history")
  history(@CurrentUser() user: User, @Query("take") take?: string) {
    return this.coachService.history(user.id, take ? parseInt(take, 10) : undefined);
  }
}
