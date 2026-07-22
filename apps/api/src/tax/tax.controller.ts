import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { TaxService } from "./tax.service";
import { CreateDeductionDto } from "./dto/create-deduction.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { currentFinancialYear } from "../common/utils/financial-year.util";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("tax")
export class TaxController {
  constructor(private taxService: TaxService) {}

  @Get("deductions")
  listDeductions(@CurrentUser() user: User, @Query("financialYear") financialYear?: string) {
    return this.taxService.listDeductions(user.id, financialYear ?? currentFinancialYear());
  }

  @Post("deductions")
  addDeduction(@CurrentUser() user: User, @Body() dto: CreateDeductionDto) {
    return this.taxService.addDeduction(user.id, dto);
  }

  @Delete("deductions/:id")
  removeDeduction(@CurrentUser() user: User, @Param("id") id: string) {
    return this.taxService.removeDeduction(user.id, id);
  }

  @Get("estimate")
  estimate(@CurrentUser() user: User, @Query("financialYear") financialYear?: string) {
    return this.taxService.estimate(user.id, financialYear ?? currentFinancialYear());
  }
}
