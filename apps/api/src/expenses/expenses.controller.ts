import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ExpensesService } from "./expenses.service";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller()
export class ExpensesController {
  constructor(private expensesService: ExpensesService) {}

  @Get("categories")
  listCategories() {
    return this.expensesService.listCategories();
  }

  @Post("categories")
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.expensesService.createCategory(dto);
  }

  @Get("expenses")
  list(@CurrentUser() user: User, @Query("month") month?: string) {
    return this.expensesService.list(user.id, month);
  }

  @Post("expenses")
  create(@CurrentUser() user: User, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(user.id, dto);
  }

  @Patch("expenses/:id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateExpenseDto) {
    return this.expensesService.update(user.id, id, dto);
  }

  @Delete("expenses/:id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.expensesService.remove(user.id, id);
  }

  @Get("expenses/breakdown")
  breakdown(@CurrentUser() user: User, @Query("month") month?: string) {
    return this.expensesService.categoryBreakdown(user.id, month);
  }

  @Get("expenses/subscriptions")
  subscriptions(@CurrentUser() user: User) {
    return this.expensesService.detectSubscriptions(user.id);
  }
}
