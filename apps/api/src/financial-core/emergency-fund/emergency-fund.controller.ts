import { Body, Controller, Delete, Get, Param, Post, UseGuards } from "@nestjs/common";
import { User } from "@wealthos/db";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { EmergencyFundService } from "./emergency-fund.service";
import { CreateEmergencyEntryDto } from "./dto/create-emergency-entry.dto";

@UseGuards(SessionAuthGuard)
@Controller("emergency-fund")
export class EmergencyFundController {
  constructor(private service: EmergencyFundService) {}

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.service.summary(user.id);
  }

  @Get("entries")
  list(@CurrentUser() user: User) {
    return this.service.list(user.id);
  }

  @Post("entries")
  create(@CurrentUser() user: User, @Body() dto: CreateEmergencyEntryDto) {
    return this.service.create(user.id, dto);
  }

  @Delete("entries/:id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.service.remove(user.id, id);
  }
}
