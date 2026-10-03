import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { FinancialEngineService } from "./financial-engine.service";
import { AskFinancialEngineDto } from "./dto/ask-financial-engine.dto";

// The user id is taken from the authenticated session only; the body carries just the
// question, so a client can never ask about another user's finances.
@UseGuards(SessionAuthGuard)
@Controller("financial-engine")
export class FinancialEngineController {
  constructor(private engine: FinancialEngineService) {}

  @Post("ask")
  ask(@CurrentUser() user: User, @Body() dto: AskFinancialEngineDto) {
    return this.engine.ask(user.id, dto.question);
  }
}
