import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from "@nestjs/common";
import { IncomeService } from "./income.service";
import { CreateIncomeDto } from "./dto/create-income.dto";
import { UpdateIncomeDto } from "./dto/update-income.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("income")
export class IncomeController {
  constructor(private incomeService: IncomeService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.incomeService.list(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateIncomeDto) {
    return this.incomeService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateIncomeDto) {
    return this.incomeService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.incomeService.remove(user.id, id);
  }
}
