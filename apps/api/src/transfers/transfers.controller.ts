import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { RateLimitGuard } from "../common/guards/rate-limit.guard";
import { RateLimit } from "../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { TransfersService } from "./transfers.service";
import { CreateTransferDto } from "./dto/create-transfer.dto";
import { ListTransfersQueryDto } from "./dto/list-transfers-query.dto";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("transfers")
export class TransfersController {
  constructor(private service: TransfersService) {}

  @RateLimit(120, 3600)
  @Get()
  list(@CurrentUser() user: User, @Query() query: ListTransfersQueryDto) {
    return this.service.list(user.id, query);
  }

  @RateLimit(60, 3600)
  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreateTransferDto) {
    return this.service.create(user.id, dto);
  }

  @RateLimit(60, 3600)
  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.remove(user.id, id);
  }
}
