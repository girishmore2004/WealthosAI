import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { PropertyService } from "./property.service";
import { CreatePropertyDto } from "./dto/create-property.dto";
import { UpdatePropertyDto } from "./dto/update-property.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("property")
export class PropertyController {
  constructor(private propertyService: PropertyService) {}

  @Get()
  list(@CurrentUser() user: User) {
    return this.propertyService.list(user.id);
  }

  @Get("summary")
  summary(@CurrentUser() user: User) {
    return this.propertyService.portfolioSummary(user.id);
  }

  @Post()
  create(@CurrentUser() user: User, @Body() dto: CreatePropertyDto) {
    return this.propertyService.create(user.id, dto);
  }

  @Patch(":id")
  update(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdatePropertyDto) {
    return this.propertyService.update(user.id, id, dto);
  }

  @Delete(":id")
  remove(@CurrentUser() user: User, @Param("id") id: string) {
    return this.propertyService.remove(user.id, id);
  }

  // NEW: closes the audit-flagged Tax-integration gap for this feature. Returns null
  // (not an error) when the property isn't Section-24-eligible (no linked HOME loan, or
  // not a residential property type) — that's a normal, expected outcome for most
  // properties, not a failure.
  @Get(":id/tax-deduction-estimate")
  taxDeductionEstimate(
    @CurrentUser() user: User,
    @Param("id") id: string,
    @Query("financialYear") financialYear?: string,
  ) {
    return this.propertyService.estimateHomeLoanInterestDeduction(user.id, id, financialYear);
  }
}
