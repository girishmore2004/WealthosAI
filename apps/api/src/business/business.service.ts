import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateObligationDto } from "./dto/create-obligation.dto";
import { UpdateObligationDto } from "./dto/update-obligation.dto";
import { BusinessSummaryDTO } from "@wealthos/types";

const TREND_MONTHS = 6;

@Injectable()
export class BusinessService {
  constructor(private prisma: PrismaService) {}

  listBusinesses(userId: string) {
    return this.prisma.client.business.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  }

  createBusiness(userId: string, dto: CreateBusinessDto) {
    return this.prisma.client.business.create({
      data: { ...dto, userId, startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined },
    });
  }

  // Lets the owner correct the business's own metadata (name, entity type, currency,
  // start date, ownership %) without touching transactions/obligations underneath it.
  async updateBusiness(userId: string, businessId: string, dto: UpdateBusinessDto) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.business.update({
      where: { id: businessId },
      data: { ...dto, startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined },
    });
  }

  async removeBusiness(userId: string, businessId: string) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.business.delete({ where: { id: businessId } });
  }

  async listTransactions(userId: string, businessId: string) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.businessTransaction.findMany({
      where: { businessId },
      orderBy: { occurredAt: "desc" },
    });
  }

  async createTransaction(userId: string, businessId: string, dto: CreateTransactionDto) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.businessTransaction.create({
      data: { ...dto, businessId, occurredAt: new Date(dto.occurredAt) },
    });
  }

  async updateTransaction(userId: string, transactionId: string, dto: UpdateTransactionDto) {
    const txn = await this.prisma.client.businessTransaction.findUnique({ where: { id: transactionId } });
    if (!txn) throw new NotFoundException("Transaction not found");
    await this.assertBusinessOwnership(userId, txn.businessId);
    return this.prisma.client.businessTransaction.update({
      where: { id: transactionId },
      data: { ...dto, occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined },
    });
  }

  async removeTransaction(userId: string, transactionId: string) {
    const txn = await this.prisma.client.businessTransaction.findUnique({ where: { id: transactionId } });
    if (!txn) throw new NotFoundException("Transaction not found");
    await this.assertBusinessOwnership(userId, txn.businessId);
    return this.prisma.client.businessTransaction.delete({ where: { id: transactionId } });
  }

  async listObligations(userId: string, businessId: string) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.businessObligation.findMany({
      where: { businessId },
      orderBy: { dueDate: "asc" },
    });
  }

  async createObligation(userId: string, businessId: string, dto: CreateObligationDto) {
    await this.assertBusinessOwnership(userId, businessId);
    return this.prisma.client.businessObligation.create({
      data: { ...dto, businessId, dueDate: new Date(dto.dueDate) },
    });
  }

  async updateObligation(userId: string, obligationId: string, dto: UpdateObligationDto) {
    const obligation = await this.prisma.client.businessObligation.findUnique({ where: { id: obligationId } });
    if (!obligation) throw new NotFoundException("Obligation not found");
    await this.assertBusinessOwnership(userId, obligation.businessId);
    return this.prisma.client.businessObligation.update({
      where: { id: obligationId },
      data: { ...dto, dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined },
    });
  }

  async removeObligation(userId: string, obligationId: string) {
    const obligation = await this.prisma.client.businessObligation.findUnique({ where: { id: obligationId } });
    if (!obligation) throw new NotFoundException("Obligation not found");
    await this.assertBusinessOwnership(userId, obligation.businessId);
    return this.prisma.client.businessObligation.delete({ where: { id: obligationId } });
  }

  // Used by AlertsService — obligations due soon across every business the user owns,
  // without requiring the caller to already know each businessId.
  async upcomingObligationsForUser(userId: string, withinDays = 14) {
    const businesses = await this.listBusinesses(userId);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + withinDays);

    return this.prisma.client.businessObligation.findMany({
      where: { businessId: { in: businesses.map((b) => b.id) }, dueDate: { lte: cutoff, gte: new Date() } },
      include: { business: true },
      orderBy: { dueDate: "asc" },
    });
  }

  private monthKey(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  }

  async monthlySummary(userId: string, businessId: string, month?: string): Promise<BusinessSummaryDTO> {
    await this.assertBusinessOwnership(userId, businessId);
    const targetMonth = month ?? this.monthKey(new Date());

    const trendStart = new Date(`${targetMonth}-01T00:00:00.000Z`);
    trendStart.setMonth(trendStart.getMonth() - (TREND_MONTHS - 1));

    const transactions = await this.prisma.client.businessTransaction.findMany({
      where: { businessId, occurredAt: { gte: trendStart } },
    });

    const byMonth = new Map<string, { revenue: number; expenses: number; drawings: number }>();
    for (const txn of transactions) {
      const key = this.monthKey(txn.occurredAt);
      const bucket = byMonth.get(key) ?? { revenue: 0, expenses: 0, drawings: 0 };
      const amount = Number(txn.amount);
      if (txn.type === "REVENUE") bucket.revenue += amount;
      else if (txn.type === "EXPENSE") bucket.expenses += amount;
      else bucket.drawings += amount;
      byMonth.set(key, bucket);
    }

    const trend: BusinessSummaryDTO["trend"] = [];
    const cursor = new Date(trendStart);
    for (let i = 0; i < TREND_MONTHS; i++) {
      const key = this.monthKey(cursor);
      const bucket = byMonth.get(key) ?? { revenue: 0, expenses: 0, drawings: 0 };
      trend.push({ month: key, revenue: bucket.revenue, expenses: bucket.expenses, profit: bucket.revenue - bucket.expenses });
      cursor.setMonth(cursor.getMonth() + 1);
    }

    const current = byMonth.get(targetMonth) ?? { revenue: 0, expenses: 0, drawings: 0 };

    return {
      businessId,
      month: targetMonth,
      revenue: current.revenue.toFixed(2),
      expenses: current.expenses.toFixed(2),
      ownerDrawings: current.drawings.toFixed(2),
      profit: (current.revenue - current.expenses).toFixed(2),
      trend,
    };
  }

  // Sum of net profit across every business the user owns for a given financial year —
  // used by the Reports module. Intentionally NOT auto-injected into personal Income or
  // the Tax estimate: business P&L and the owner's personal taxable income are related
  // but distinct (the owner should log their own drawings/salary as personal Income),
  // so auto-merging them here would risk silently double-counting money.
  async annualProfitForUser(userId: string, fyStart: Date, fyEnd: Date): Promise<number | null> {
    const businesses = await this.listBusinesses(userId);
    if (businesses.length === 0) return null;

    const transactions = await this.prisma.client.businessTransaction.findMany({
      where: { businessId: { in: businesses.map((b) => b.id) }, occurredAt: { gte: fyStart, lte: fyEnd } },
    });

    return transactions.reduce((sum, t) => {
      if (t.type === "REVENUE") return sum + Number(t.amount);
      if (t.type === "EXPENSE") return sum - Number(t.amount);
      return sum;
    }, 0);
  }

  private async assertBusinessOwnership(userId: string, businessId: string) {
    const business = await this.prisma.client.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found");
    if (business.userId !== userId) throw new ForbiddenException();
  }
}
