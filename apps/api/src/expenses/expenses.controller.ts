import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ExpensesService } from "./expenses.service";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { ListExpensesQueryDto } from "./dto/list-expenses-query.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { RecurrenceGeneratorService } from "../common/recurrence/recurrence-generator.service";
import { ActivateExpenseRecurrenceDto } from "../common/recurrence/dto/activate-expense-recurrence.dto";

@UseGuards(SessionAuthGuard)
@Controller()
export class ExpensesController {
  constructor(
    private expensesService: ExpensesService,
    private recurrenceGenerator: RecurrenceGeneratorService,
  ) {}

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

  // Opt-in paginated + filterable listing. Existing GET /expenses above is left exactly
  // as-is (unbounded array response) since the current expenses page consumes it
  // directly as an array; this is additive for future UI/API consumers that need bounded
  // result sets (e.g. a long-lived account's full expense history).
  @Get("expenses/paged")
  listPaged(@CurrentUser() user: User, @Query() query: ListExpensesQueryDto) {
    return this.expensesService.listPaged(user.id, query);
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

  // NEW (audit item #3): same opt-in recurring-generation controls as Income, applied
  // to a single Expense row. Unlike Income, activation requires supplying the
  // cadence (Expense had no recurrence field to reuse before this change) — see
  // ActivateExpenseRecurrenceDto.
  @Post("expenses/:id/recurrence/activate")
  activateRecurrence(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: ActivateExpenseRecurrenceDto) {
    return this.recurrenceGenerator.activateExpenseRecurrence(user.id, id, dto.recurrence, dto.endDate);
  }

  @Post("expenses/:id/recurrence/deactivate")
  deactivateRecurrence(@CurrentUser() user: User, @Param("id") id: string) {
    return this.recurrenceGenerator.deactivateExpenseRecurrence(user.id, id);
  }

  @Get("expenses/:id/recurrence/preview")
  previewRecurrence(@CurrentUser() user: User, @Param("id") id: string) {
    return this.recurrenceGenerator.previewExpenseOccurrences(user.id, id);
  }
}
