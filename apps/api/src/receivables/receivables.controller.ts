import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { ReceivablesService } from "./receivables.service";
import { CreateReceivableDto } from "./dto/create-receivable.dto";
import { UpdateReceivableDto } from "./dto/update-receivable.dto";
import { RecordRepaymentDto } from "./dto/record-repayment.dto";
import { ListReceivablesQueryDto } from "./dto/list-receivables-query.dto";

// userId always comes from the authenticated session, never from the request.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("receivables")
export class ReceivablesController {
  constructor(private service: ReceivablesService) {}

  @RateLimit(120, 3600)
  @Get()
  list(@CurrentUser() user: User, @Query() query: ListReceivablesQueryDto) {
    return this.service.list(user.id, query);
  }

  // Declared before ":id" so "summary" is never captured as an id.
  @RateLimit(120, 3600)
  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.service.summary(user.id);
  }

  @RateLimit(120, 3600)
  @Get(":id")
  get(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.get(user.id, id);
  }

  @RateLimit(60, 3600)
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateReceivableDto) {
    return this.service.create(user.id, dto);
  }

  @RateLimit(60, 3600)
  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateReceivableDto) {
    return this.service.update(user.id, id, dto);
  }

  @RateLimit(60, 3600)
  @Post(":id/repayments")
  recordRepayment(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: RecordRepaymentDto) {
    return this.service.recordRepayment(user.id, id, dto);
  }

  @RateLimit(60, 3600)
  @Delete(":id/repayments/:repaymentId")
  removeRepayment(@CurrentUser() user: User, @Param("id") id: string, @Param("repaymentId") repaymentId: string) {
    return this.service.removeRepayment(user.id, id, repaymentId);
  }

  @RateLimit(60, 3600)
  @Post(":id/cancel")
  cancel(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.cancel(user.id, id);
  }

  @RateLimit(60, 3600)
  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.remove(user.id, id);
  }
}
