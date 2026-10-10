import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ExpensesService } from "./expenses.service";
import { ExpenseRecurrenceEditService } from "./expense-recurrence-edit.service";
import { ExpenseDeleteModeQueryDto, ExpenseEditScopeQueryDto, UpdateRecurrenceRuleDto } from "./dto/recurrence-edit.dto";
import { CreateExpenseDto } from "./dto/create-expense.dto";
import { UpdateExpenseDto } from "./dto/update-expense.dto";
import { CreateCategoryDto } from "./dto/create-category.dto";
import { ListExpensesQueryDto } from "./dto/list-expenses-query.dto";
import { ExpenseAnalyticsQueryDto } from "./dto/expense-analytics-query.dto";
import { QuickExpenseDto } from "./dto/quick-expense.dto";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
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
    private recurrenceEdits: ExpenseRecurrenceEditService,
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

  // QUICK EXPENSE: minimal fields, defaults to today / UPI, and returns the saved expense plus
  // what it changed (that category's and all categories' totals for its day, month and year).
  // Declared before the ":id" routes; "quick" is never captured as an id (those are PATCH/DELETE
  // or nested paths).
  @UseGuards(RateLimitGuard)
  @RateLimit(120, 3600)
  @Post("expenses/quick")
  quickCreate(@CurrentUser() user: User, @Body() dto: QuickExpenseDto) {
    return this.expensesService.quickCreate(user.id, dto);
  }

  // Today / this month / this year totals in one cheap call (the expense page header).
  @UseGuards(RateLimitGuard)
  @RateLimit(240, 3600)
  @Get("expenses/summary")
  summary(@CurrentUser() user: User, @Query("today") today?: string, @Query("flowType") flowType?: string) {
    return this.expensesService.periodTotals(user.id, today, flowType === "OTHER_OUTFLOW" ? "OTHER_OUTFLOW" : "EXPENSE");
  }

  // Aggregated spending analytics (daily/weekly/monthly series, category totals, extremes and
  // period comparisons), computed in the database. Pass categoryId for a category drill-down.
  @UseGuards(RateLimitGuard)
  @RateLimit(120, 3600)
  @Get("expenses/analytics")
  analytics(@CurrentUser() user: User, @Query() query: ExpenseAnalyticsQueryDto) {
    return this.expensesService.analytics(user.id, query);
  }

  @Post("expenses")
  create(@CurrentUser() user: User, @Body() dto: CreateExpenseDto) {
    return this.expensesService.create(user.id, dto);
  }

  // ?scope=THIS (default) | FUTURE. For an ordinary expense this is exactly the original update;
  // for a recurring one it decides which occurrences the edit applies to (see
  // ExpenseRecurrenceEditService). Historical rows never change unless you chose to change them.
  @Patch("expenses/:id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateExpenseDto, @Query() q: ExpenseEditScopeQueryDto) {
    return this.recurrenceEdits.update(user.id, id, dto, q.scope);
  }

  // Edits the repeat RULE only (cadence, end date, amount …) — never an existing expense.
  @Patch("expenses/:id/recurrence")
  updateRule(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateRecurrenceRuleDto) {
    return this.recurrenceEdits.updateRule(user.id, id, dto);
  }

  // ?mode=THIS (default) | FUTURE. An active recurrence template is refused (stop the recurrence
  // first); FUTURE removes an auto-generated occurrence and every later one, keeping the rule.
  @Delete("expenses/:id")
  remove(@CurrentUser() user: User, @Param("id") id: string, @Query() q: ExpenseDeleteModeQueryDto) {
    return this.recurrenceEdits.remove(user.id, id, q.mode);
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
