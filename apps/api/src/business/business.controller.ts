import { Body, Controller, Delete, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { BusinessService } from "./business.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateObligationDto } from "./dto/create-obligation.dto";
import { UpdateObligationDto } from "./dto/update-obligation.dto";
import { SessionAuthGuard } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";

@UseGuards(SessionAuthGuard)
@Controller("business")
export class BusinessController {
  constructor(private businessService: BusinessService) {}

  @Get()
  listBusinesses(@CurrentUser() user: User) {
    return this.businessService.listBusinesses(user.id);
  }

  @Post()
  createBusiness(@CurrentUser() user: User, @Body() dto: CreateBusinessDto) {
    return this.businessService.createBusiness(user.id, dto);
  }

  @Patch(":businessId")
  updateBusiness(@CurrentUser() user: User, @Param("businessId") businessId: string, @Body() dto: UpdateBusinessDto) {
    return this.businessService.updateBusiness(user.id, businessId, dto);
  }

  @Delete(":businessId")
  removeBusiness(@CurrentUser() user: User, @Param("businessId") businessId: string) {
    return this.businessService.removeBusiness(user.id, businessId);
  }

  @Get(":businessId/transactions")
  listTransactions(@CurrentUser() user: User, @Param("businessId") businessId: string) {
    return this.businessService.listTransactions(user.id, businessId);
  }

  @Post(":businessId/transactions")
  createTransaction(
    @CurrentUser() user: User,
    @Param("businessId") businessId: string,
    @Body() dto: CreateTransactionDto,
  ) {
    return this.businessService.createTransaction(user.id, businessId, dto);
  }

  @Patch("transactions/:id")
  updateTransaction(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateTransactionDto) {
    return this.businessService.updateTransaction(user.id, id, dto);
  }

  @Delete("transactions/:id")
  removeTransaction(@CurrentUser() user: User, @Param("id") id: string) {
    return this.businessService.removeTransaction(user.id, id);
  }

  // NEW: closes the audit-flagged gap — business drawings never automatically flowed
  // into personal Income. A dedicated, explicit opt-in action (not a side effect of
  // create/update) — see BusinessService.syncDrawingToIncome()'s doc comment for why.
  @Post("transactions/:id/sync-to-income")
  syncDrawingToIncome(@CurrentUser() user: User, @Param("id") id: string) {
    return this.businessService.syncDrawingToIncome(user.id, id);
  }

  @Delete("transactions/:id/sync-to-income")
  unsyncDrawingFromIncome(@CurrentUser() user: User, @Param("id") id: string) {
    return this.businessService.unsyncDrawingFromIncome(user.id, id);
  }

  @Get(":businessId/obligations")
  listObligations(@CurrentUser() user: User, @Param("businessId") businessId: string) {
    return this.businessService.listObligations(user.id, businessId);
  }

  @Post(":businessId/obligations")
  createObligation(
    @CurrentUser() user: User,
    @Param("businessId") businessId: string,
    @Body() dto: CreateObligationDto,
  ) {
    return this.businessService.createObligation(user.id, businessId, dto);
  }

  @Patch("obligations/:id")
  updateObligation(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateObligationDto) {
    return this.businessService.updateObligation(user.id, id, dto);
  }

  @Delete("obligations/:id")
  removeObligation(@CurrentUser() user: User, @Param("id") id: string) {
    return this.businessService.removeObligation(user.id, id);
  }

  // NEW: closes the audit-flagged recurring-obligation gap. A dedicated action, not a
  // side effect of the generic PATCH above — see BusinessService.markObligationPaid()'s
  // doc comment for why. Response includes both the now-PAID row and the newly created
  // next occurrence (or null for a one-time obligation, or an already-paid retry).
  @Post("obligations/:id/mark-paid")
  markObligationPaid(@CurrentUser() user: User, @Param("id") id: string) {
    return this.businessService.markObligationPaid(user.id, id);
  }

  @Get(":businessId/summary")
  summary(@CurrentUser() user: User, @Param("businessId") businessId: string, @Query("month") month?: string) {
    return this.businessService.monthlySummary(user.id, businessId, month);
  }
}
