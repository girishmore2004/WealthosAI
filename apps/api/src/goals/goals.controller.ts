import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { GoalsService } from "./goals.service";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("goals")
export class GoalsController {
  constructor(private goalsService: GoalsService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.goalsService.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateGoalDto) {
    return this.goalsService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateGoalDto) {
    return this.goalsService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.goalsService.remove(user.id, id);
  }
}
