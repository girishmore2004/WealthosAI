import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreateBusinessDto } from "./dto/create-business.dto";
import { UpdateBusinessDto } from "./dto/update-business.dto";
import { CreateTransactionDto } from "./dto/create-transaction.dto";
import { UpdateTransactionDto } from "./dto/update-transaction.dto";
import { CreateObligationDto } from "./dto/create-obligation.dto";
import { UpdateObligationDto } from "./dto/update-obligation.dto";
import { BusinessSummaryDTO } from "@wealthos/types";
import { BusinessObligation, Recurrence } from "@wealthos/db";

const TREND_MONTHS = 6;

// Advances a due date by one recurrence interval — the piece that was actually missing
// before this change. The schema already had BusinessObligation.recurrence (and
// CreateObligationDto already accepted it), but nothing anywhere ever *used* it: a
// user still had to manually re-create "File GST Return" every single month even
// though the field describing how often it recurs was sitting right there, unused.
function advanceDueDate(current: Date, recurrence: Recurrence): Date {
  const next = new Date(current);
  switch (recurrence) {
    case "WEEKLY":
      next.setDate(next.getDate() + 7);
      return next;
    case "MONTHLY":
      next.setMonth(next.getMonth() + 1);
      return next;
    case "QUARTERLY":
      next.setMonth(next.getMonth() + 3);
      return next;
    case "YEARLY":
      next.setFullYear(next.getFullYear() + 1);
      return next;
    case "ONE_TIME":
    default:
      return current; // callers guard against invoking this for ONE_TIME
  }
}

@Injectable()
export class BusinessService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
  ) {}

  listBusinesses(userId: string) {
    return this.prisma.client.business.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
  }

  createBusiness(userId: string, dto: CreateBusinessDto) {
    return this.prisma.client.business.create({
      data: { ...dto, userId, startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to every other money module this session: closes the
  // TOCTOU gap between "check ownership" and "perform the write," and collapses a
  // cross-user access attempt and a nonexistent id into the same 404 rather than
  // leaking which case occurred via a 403/404 split.
  async updateBusiness(userId: string, businessId: string, dto: UpdateBusinessDto) {
    const result = await this.prisma.client.business.updateMany({
      where: { id: businessId, userId },
      data: { ...dto, startedAt: dto.startedAt ? new Date(dto.startedAt) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Business not found");
    }

    return this.prisma.client.business.findUnique({ where: { id: businessId } });
  }

  // Genuine round-trip reduction too: one deleteMany({ id, userId }) replaces the
  // previous findUnique-then-delete pair. Returns { id } rather than the deleted row —
  // verified against apps/web's business page, which never calls a remove-business
  // action at all today (only transactions/obligations are removable from the current
  // UI), so this change has zero frontend impact either way.
  async removeBusiness(userId: string, businessId: string) {
    const result = await this.prisma.client.business.deleteMany({ where: { id: businessId, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Business not found");
    }

    return { id: businessId };
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

  // BusinessTransaction has no userId column of its own — ownership is via
  // businessId -> Business.userId. Prisma supports filtering updateMany/deleteMany
  // through a relation exactly like findMany, so `business: { userId }` in the where
  // clause is still a single atomic, ownership-scoped statement — not a second
  // round-trip.
  async updateTransaction(userId: string, transactionId: string, dto: UpdateTransactionDto) {
    const result = await this.prisma.client.businessTransaction.updateMany({
      where: { id: transactionId, business: { userId } },
      data: { ...dto, occurredAt: dto.occurredAt ? new Date(dto.occurredAt) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Transaction not found");
    }

    return this.prisma.client.businessTransaction.findUnique({ where: { id: transactionId } });
  }

  async removeTransaction(userId: string, transactionId: string) {
    const result = await this.prisma.client.businessTransaction.deleteMany({
      where: { id: transactionId, business: { userId } },
    });

    if (result.count === 0) {
      throw new NotFoundException("Transaction not found");
    }

    return { id: transactionId };
  }

  // NEW: closes the audit-flagged gap — "no code path anywhere in business.service.ts
  // creates an Income row from BusinessTransaction/OWNER_DRAWING — business profit and
  // drawings still do not automatically flow into personal Income, Dashboard, or Tax."
  //
  // Deliberately an explicit, opt-in action per transaction (not automatic on
  // creation) — see the master preservation rules: business P&L and the owner's
  // personal taxable income are related but distinct, and auto-merging them risks
  // silently double-counting money (annualProfitForUser() above is intentionally NOT
  // folded into personal Income for the same reason). Only OWNER_DRAWING transactions
  // are eligible — REVENUE/EXPENSE describe the business's own books, not money that
  // moved to the owner personally.
  //
  // Idempotent by construction: once a transaction has a syncedIncomeId, a second call
  // throws rather than creating a duplicate Income row.
  async syncDrawingToIncome(userId: string, transactionId: string) {
    const transaction = await this.prisma.client.businessTransaction.findUnique({
      where: { id: transactionId },
      include: { business: true },
    });
    if (!transaction || transaction.business.userId !== userId) {
      throw new NotFoundException("Transaction not found");
    }
    if (transaction.type !== "OWNER_DRAWING") {
      throw new BadRequestException("Only OWNER_DRAWING transactions can be synced to personal Income.");
    }
    if (transaction.syncedIncomeId) {
      throw new BadRequestException("This transaction has already been synced to Income.");
    }

    const income = await this.incomeService.create(userId, {
      source: "BUSINESS",
      label: `Owner drawing — ${transaction.business.name}`,
      amount: Number(transaction.amount),
      recurrence: "ONE_TIME",
      receivedAt: transaction.occurredAt.toISOString(),
      notes: transaction.description ?? undefined,
    });

    await this.prisma.client.businessTransaction.update({
      where: { id: transactionId },
      data: { syncedIncomeId: income.id },
    });

    return { transactionId, income };
  }

  // Reverses syncDrawingToIncome() — deletes the linked Income row and clears the
  // link, so a user who synced a drawing by mistake (or is cleaning up a duplicate)
  // isn't stuck with an orphaned Income row they have to find and delete manually
  // themselves. Every new automated financial write in this batch is reversible, per
  // the master preservation rules.
  async unsyncDrawingFromIncome(userId: string, transactionId: string) {
    const transaction = await this.prisma.client.businessTransaction.findUnique({
      where: { id: transactionId },
      include: { business: true },
    });
    if (!transaction || transaction.business.userId !== userId) {
      throw new NotFoundException("Transaction not found");
    }
    if (!transaction.syncedIncomeId) {
      throw new BadRequestException("This transaction was never synced to Income.");
    }

    // Ownership-scoped delete (not a bare deleteMany by id alone) — the Income row
    // belongs to the user via userId directly (Income has no businessId), so this is
    // the same atomic, ownership-scoped pattern used everywhere else in this codebase,
    // not a second unchecked round-trip.
    await this.prisma.client.income.deleteMany({ where: { id: transaction.syncedIncomeId, userId } });

    return this.prisma.client.businessTransaction.update({
      where: { id: transactionId },
      data: { syncedIncomeId: null },
    });
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

  // Same relation-scoped atomic pattern as updateTransaction() above.
  async updateObligation(userId: string, obligationId: string, dto: UpdateObligationDto) {
    const result = await this.prisma.client.businessObligation.updateMany({
      where: { id: obligationId, business: { userId } },
      data: { ...dto, dueDate: dto.dueDate ? new Date(dto.dueDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Obligation not found");
    }

    return this.prisma.client.businessObligation.findUnique({ where: { id: obligationId } });
  }

  async removeObligation(userId: string, obligationId: string) {
    const result = await this.prisma.client.businessObligation.deleteMany({
      where: { id: obligationId, business: { userId } },
    });

    if (result.count === 0) {
      throw new NotFoundException("Obligation not found");
    }

    return { id: obligationId };
  }

  // NEW — closes the audit-flagged gap: "Add a recurrence field to BusinessObligation
  // for monthly/quarterly GST-style filings so the user doesn't have to manually
  // re-create the same obligation every period." The schema/DTO-level `recurrence`
  // field already existed but nothing used it; this is the missing logic. A dedicated
  // action endpoint (not folded into the generic updateObligation PATCH) so marking an
  // obligation paid is an explicit, intentional action a caller opts into — a generic
  // field-edit PATCH that happens to include `status: PAID` should not have the
  // surprising side effect of silently creating a brand new obligation row.
  //
  // Idempotency: if the obligation was ALREADY status=PAID before this call (a retried
  // request, a double-clicked button), the next occurrence is NOT created a second
  // time — only a genuine PENDING/OVERDUE -> PAID transition rolls forward. ONE_TIME
  // obligations never roll forward at all, regardless of prior status.
  async markObligationPaid(
    userId: string,
    obligationId: string,
  ): Promise<{ paid: BusinessObligation; nextOccurrence: BusinessObligation | null }> {
    const obligation = await this.prisma.client.businessObligation.findUnique({
      where: { id: obligationId },
    });
    if (!obligation) throw new NotFoundException("Obligation not found");
    await this.assertBusinessOwnership(userId, obligation.businessId);

    const wasAlreadyPaid = obligation.status === "PAID";

    const paid = await this.prisma.client.businessObligation.update({
      where: { id: obligationId },
      data: { status: "PAID" },
    });

    if (wasAlreadyPaid || obligation.recurrence === "ONE_TIME") {
      return { paid, nextOccurrence: null };
    }

    const nextOccurrence = await this.prisma.client.businessObligation.create({
      data: {
        businessId: obligation.businessId,
        title: obligation.title,
        dueDate: advanceDueDate(obligation.dueDate, obligation.recurrence),
        amount: obligation.amount,
        recurrence: obligation.recurrence,
        vendor: obligation.vendor,
        status: "PENDING",
        notes: obligation.notes,
      },
    });

    return { paid, nextOccurrence };
  }

  // Used by AlertsService — obligations due soon across every business the user owns,
  // without requiring the caller to already know each businessId. Unchanged: newly
  // auto-created recurring obligations from markObligationPaid() above are ordinary
  // PENDING rows, so they surface here automatically once their due date falls inside
  // the alert window — no changes needed in this method or in Alerts.
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
  // so auto-merging them here would risk silently double-counting money. Left
  // arithmetically unchanged.
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

  // Still used by the read paths (listTransactions/createTransaction/listObligations/
  // createObligation/monthlySummary) where a single-row ownership pre-check ahead of a
  // separate operation is the right shape; only the update/remove paths above moved to
  // the atomic updateMany/deleteMany pattern, since those are where the TOCTOU gap and
  // round-trip savings actually apply.
  private async assertBusinessOwnership(userId: string, businessId: string) {
    const business = await this.prisma.client.business.findUnique({ where: { id: businessId } });
    if (!business) throw new NotFoundException("Business not found");
    if (business.userId !== userId) throw new NotFoundException("Business not found");
  }
}
