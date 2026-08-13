import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { IncomeService } from "./income.service";
import { CreateIncomeDto } from "./dto/create-income.dto";
import { UpdateIncomeDto } from "./dto/update-income.dto";
import { ListIncomeQueryDto } from "./dto/list-income-query.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { RecurrenceGeneratorService } from "../common/recurrence/recurrence-generator.service";
import { ActivateRecurrenceDto } from "../common/recurrence/dto/activate-recurrence.dto";

@UseGuards(SessionAuthGuard)
@Controller("income")
export class IncomeController {
  constructor(
    private incomeService: IncomeService,
    private recurrenceGenerator: RecurrenceGeneratorService,
  ) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.incomeService.list(user.id);
  }

  // Opt-in paginated + date-range-filterable listing. Existing GET /income above is left
  // exactly as-is (unbounded array response) since the current income page consumes it
  // directly as an array; this is additive for future UI/API consumers that need bounded
  // result sets.
  @Get("paged")
  listPaged(@CurrentUser() user: User, @Query() query: ListIncomeQueryDto) {
    return this.incomeService.listPaged(user.id, query);
  }

  // Surfaces the same figure as monthlyForecast() (used internally by 9+ other features)
  // alongside a fuller breakdown — in particular, how much one-time income is currently
  // excluded from that monthly figure, which was previously invisible anywhere in the UI.
  @Get("breakdown")
  breakdown(@CurrentUser() user: User) {
    return this.incomeService.monthlyForecastBreakdown(user.id);
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

  // NEW (audit item #3): explicit, opt-in recurring-generation controls for a single
  // Income row. See RecurrenceGeneratorService for the actual generation logic — the
  // scheduled daily job (RecurrenceWorker) is what performs generation in the
  // background; these endpoints are for the user to turn that on/off per row and to
  // preview what it would do before committing.
  @Post(":id/recurrence/activate")
  activateRecurrence(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: ActivateRecurrenceDto) {
    return this.recurrenceGenerator.activateIncomeRecurrence(user.id, id, dto.endDate);
  }

  @Post(":id/recurrence/deactivate")
  deactivateRecurrence(@CurrentUser() user: User, @Param("id") id: string) {
    return this.recurrenceGenerator.deactivateIncomeRecurrence(user.id, id);
  }

  @Get(":id/recurrence/preview")
  previewRecurrence(@CurrentUser() user: User, @Param("id") id: string) {
    return this.recurrenceGenerator.previewIncomeOccurrences(user.id, id);
  }
}
