import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma, Receivable, ReceivableRepayment } from "@wealthos/db";
import type { ReceivableDTO, ReceivableRepaymentDTO, ReceivableSummaryDTO, RecordRepaymentResultDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { lockKey } from "../common/utils/advisory-lock.util";
import { currentMonthString, monthRange } from "../common/utils/financial-period.util";
import {
  daysUntilDue,
  effectiveReceivableStatus,
  isDueSoon,
  isOpenReceivable,
  receivableOutstanding,
  receivableStatusFor,
  toDecimal,
  toMoneyString,
  utcDayNumber,
} from "../common/financial-facts/financial-formulas";
import { CreateReceivableDto } from "./dto/create-receivable.dto";
import { UpdateReceivableDto } from "./dto/update-receivable.dto";
import { RecordRepaymentDto } from "./dto/record-repayment.dto";
import { ListReceivablesQueryDto } from "./dto/list-receivables-query.dto";

const ZERO = new Prisma.Decimal(0);
const DUE_SOON_DAYS = 7;
const DAY_MS = 86_400_000;
const LIST_LIMIT = 200;

// MONEY GIVEN / RECEIVABLE. Lending money is not spending: cash falls and a receivable asset
// of the same size appears (net worth and expenses unchanged); each repayment moves value back.
// Nothing here ever touches the Expense table — and the cash/net-worth effect is applied by
// FinancialFactsService reading these two tables, so there is exactly one place the effect lives.
//
// Returned / outstanding amounts are NEVER stored: they are derived from the repayment ledger,
// so a cached total can't drift from its history. Every write that depends on the current
// returned total (repayment, edit, repayment delete, cancel, delete) runs inside ONE
// transaction that first takes a per-receivable advisory lock, so two concurrent requests can't
// both pass the same "enough outstanding" check.
@Injectable()
export class ReceivablesService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  // ---- validation helpers ---------------------------------------------------------------

  private parseDate(value: string, field: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`Invalid ${field} date`);
    return d;
  }

  // "Given" and "returned" are things that already happened; a 1-day grace absorbs timezone
  // differences between the client's local date and the server clock.
  private assertNotFuture(d: Date, field: string) {
    if (d.getTime() > Date.now() + DAY_MS) throw new BadRequestException(`${field} cannot be in the future`);
  }

  // ---- mapping ----------------------------------------------------------------------------

  private repaymentDto(r: ReceivableRepayment): ReceivableRepaymentDTO {
    return {
      id: r.id,
      receivableId: r.receivableId,
      amount: toMoneyString(r.amount),
      returnedAt: r.returnedAt.toISOString(),
      paymentMethod: r.paymentMethod,
      notes: r.notes,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private view(row: Receivable, returned: Prisma.Decimal, now: Date, repayments?: ReceivableRepayment[]): ReceivableDTO {
    const original = toDecimal(row.originalAmount);
    // A cancelled (void) receivable owes nothing and counts nowhere.
    const outstanding = row.status === "CANCELLED" ? ZERO : receivableOutstanding(original, returned);
    return {
      id: row.id,
      person: row.person,
      purpose: row.purpose,
      originalAmount: toMoneyString(original),
      returnedAmount: toMoneyString(returned),
      outstandingAmount: toMoneyString(outstanding),
      currency: row.currency,
      givenAt: row.givenAt.toISOString(),
      expectedReturnAt: row.expectedReturnAt ? row.expectedReturnAt.toISOString() : null,
      status: row.status,
      effectiveStatus: effectiveReceivableStatus(row.status, row.expectedReturnAt, now),
      daysUntilDue: isOpenReceivable(row.status) ? daysUntilDue(row.expectedReturnAt, now) : null,
      paymentMethod: row.paymentMethod,
      notes: row.notes,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      ...(repayments ? { repayments: repayments.map((r) => this.repaymentDto(r)) } : {}),
    };
  }

  /** Sum of repayments per receivable, in ONE grouped query (no N+1). */
  private async returnedByReceivable(userId: string, ids: string[]): Promise<Map<string, Prisma.Decimal>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.client.receivableRepayment.groupBy({
      by: ["receivableId"],
      where: { userId, receivableId: { in: ids } },
      _sum: { amount: true },
    });
    return new Map(rows.map((r) => [r.receivableId, toDecimal(r._sum.amount)]));
  }

  private async returnedTotal(tx: Prisma.TransactionClient, receivableId: string): Promise<Prisma.Decimal> {
    const agg = await tx.receivableRepayment.aggregate({ where: { receivableId }, _sum: { amount: true } });
    return toDecimal(agg._sum.amount);
  }

  private async viewById(userId: string, id: string, withRepayments = false): Promise<ReceivableDTO> {
    const row = await this.prisma.client.receivable.findFirst({ where: { id, userId } });
    if (!row) throw new NotFoundException("Receivable not found");
    const [returned, repayments] = await Promise.all([
      this.returnedByReceivable(userId, [id]),
      withRepayments
        ? this.prisma.client.receivableRepayment.findMany({ where: { receivableId: id, userId }, orderBy: [{ returnedAt: "desc" }, { createdAt: "desc" }] })
        : Promise.resolve(undefined),
    ]);
    return this.view(row, returned.get(id) ?? ZERO, new Date(), repayments);
  }

  // ---- reads ------------------------------------------------------------------------------

  async list(userId: string, query: ListReceivablesQueryDto = {}): Promise<ReceivableDTO[]> {
    const scope = query.scope ?? "ALL";
    const status =
      scope === "ACTIVE"
        ? { in: ["OUTSTANDING", "PARTIALLY_RETURNED"] as Array<"OUTSTANDING" | "PARTIALLY_RETURNED"> }
        : scope === "CLOSED"
          ? { equals: "FULLY_RETURNED" as const }
          : scope === "CANCELLED"
            ? { equals: "CANCELLED" as const }
            : { not: "CANCELLED" as const };

    const rows = await this.prisma.client.receivable.findMany({
      where: { userId, status },
      orderBy: [{ givenAt: "desc" }, { createdAt: "desc" }],
      take: LIST_LIMIT,
    });
    const returned = await this.returnedByReceivable(userId, rows.map((r) => r.id));
    const now = new Date();
    return rows.map((r) => this.view(r, returned.get(r.id) ?? ZERO, now));
  }

  get(userId: string, id: string): Promise<ReceivableDTO> {
    return this.viewById(userId, id, true);
  }

  async summary(userId: string): Promise<ReceivableSummaryDTO> {
    const now = new Date();
    const { start, end } = monthRange(currentMonthString(now));

    const [openRows, returnedThisMonthAgg] = await Promise.all([
      this.prisma.client.receivable.findMany({ where: { userId, status: { in: ["OUTSTANDING", "PARTIALLY_RETURNED"] } } }),
      this.prisma.client.receivableRepayment.aggregate({
        where: { userId, returnedAt: { gte: start, lt: end }, receivable: { status: { not: "CANCELLED" } } },
        _sum: { amount: true },
      }),
    ]);
    const returned = await this.returnedByReceivable(userId, openRows.map((r) => r.id));

    let total = ZERO;
    let overdueAmount = ZERO;
    let overdueCount = 0;
    let dueSoonAmount = ZERO;
    let dueSoonCount = 0;
    let largest: { id: string; person: string; outstanding: Prisma.Decimal } | null = null;

    for (const row of openRows) {
      const outstanding = receivableOutstanding(toDecimal(row.originalAmount), returned.get(row.id) ?? ZERO);
      if (outstanding.lte(0)) continue; // defensive: an open row with nothing left owes nothing
      total = total.plus(outstanding);
      if (effectiveReceivableStatus(row.status, row.expectedReturnAt, now) === "OVERDUE") {
        overdueAmount = overdueAmount.plus(outstanding);
        overdueCount += 1;
      } else if (isDueSoon(row.status, row.expectedReturnAt, now, DUE_SOON_DAYS)) {
        dueSoonAmount = dueSoonAmount.plus(outstanding);
        dueSoonCount += 1;
      }
      if (!largest || outstanding.gt(largest.outstanding)) largest = { id: row.id, person: row.person, outstanding };
    }

    return {
      basis: "ACTUAL",
      currency: "INR",
      totalOutstanding: toMoneyString(total),
      activeCount: openRows.length,
      dueSoon: { amount: toMoneyString(dueSoonAmount), count: dueSoonCount, withinDays: DUE_SOON_DAYS },
      overdue: { amount: toMoneyString(overdueAmount), count: overdueCount },
      returnedThisMonth: toMoneyString(toDecimal(returnedThisMonthAgg._sum.amount)),
      largest: largest ? { id: largest.id, person: largest.person, outstandingAmount: toMoneyString(largest.outstanding) } : null,
    };
  }

  // ---- writes -----------------------------------------------------------------------------

  async create(userId: string, dto: CreateReceivableDto): Promise<ReceivableDTO> {
    const givenAt = this.parseDate(dto.givenAt, "givenAt");
    this.assertNotFuture(givenAt, "givenAt");
    const expectedReturnAt = dto.expectedReturnAt ? this.parseDate(dto.expectedReturnAt, "expectedReturnAt") : null;
    if (expectedReturnAt && utcDayNumber(expectedReturnAt) < utcDayNumber(givenAt)) {
      throw new BadRequestException("expectedReturnAt cannot be before the date the money was given");
    }

    const row = await this.prisma.client.receivable.create({
      data: {
        userId,
        person: dto.person,
        purpose: dto.purpose,
        originalAmount: dto.amount,
        givenAt,
        expectedReturnAt,
        paymentMethod: dto.paymentMethod,
        notes: dto.notes,
        status: "OUTSTANDING",
      },
    });
    await this.audit.log("RECEIVABLE_CREATED", userId, { receivableId: row.id, amount: toMoneyString(new Prisma.Decimal(dto.amount)) });
    return this.view(row, ZERO, new Date());
  }

  async update(userId: string, id: string, dto: UpdateReceivableDto): Promise<ReceivableDTO> {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, `receivable:${id}`);
      const row = await tx.receivable.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundException("Receivable not found");
      if (row.status === "CANCELLED") throw new BadRequestException("A cancelled receivable cannot be edited");

      const data: Prisma.ReceivableUpdateInput = {};
      if (dto.person !== undefined) data.person = dto.person;
      if (dto.purpose !== undefined) data.purpose = dto.purpose;
      if (dto.notes !== undefined) data.notes = dto.notes;
      if (dto.paymentMethod !== undefined) data.paymentMethod = dto.paymentMethod;

      const givenAt = dto.givenAt !== undefined ? this.parseDate(dto.givenAt, "givenAt") : row.givenAt;
      if (dto.givenAt !== undefined) {
        this.assertNotFuture(givenAt, "givenAt");
        // The money cannot have been given after it started coming back.
        const first = await tx.receivableRepayment.aggregate({ where: { receivableId: id }, _min: { returnedAt: true } });
        if (first._min.returnedAt && utcDayNumber(givenAt) > utcDayNumber(first._min.returnedAt)) {
          throw new BadRequestException("givenAt cannot be after the first repayment on this receivable");
        }
        data.givenAt = givenAt;
      }

      if (dto.expectedReturnAt !== undefined) {
        const expected = this.parseDate(dto.expectedReturnAt, "expectedReturnAt");
        if (utcDayNumber(expected) < utcDayNumber(givenAt)) {
          throw new BadRequestException("expectedReturnAt cannot be before the date the money was given");
        }
        data.expectedReturnAt = expected;
      }

      if (dto.amount !== undefined) {
        const returned = await this.returnedTotal(tx, id);
        const next = new Prisma.Decimal(dto.amount);
        if (next.lt(returned)) {
          throw new BadRequestException(
            `Amount cannot be less than the ${toMoneyString(returned)} already returned. Delete the mistaken repayment first if it was wrong.`,
          );
        }
        data.originalAmount = next;
        data.status = receivableStatusFor(next, returned);
      }

      await tx.receivable.update({ where: { id }, data });
    });
    await this.audit.log("RECEIVABLE_UPDATED", userId, { receivableId: id });
    return this.viewById(userId, id, true);
  }

  async recordRepayment(userId: string, id: string, dto: RecordRepaymentDto): Promise<RecordRepaymentResultDTO> {
    const returnedAt = this.parseDate(dto.returnedAt, "returnedAt");
    this.assertNotFuture(returnedAt, "returnedAt");
    const amount = new Prisma.Decimal(dto.amount);

    // Cash effect + receivable reduction are the SAME write: the repayment row is the only
    // thing stored, and both the receivable balance and cash are derived from it.
    const outcome = await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, `receivable:${id}`);
      const row = await tx.receivable.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundException("Receivable not found");
      if (row.status === "CANCELLED") throw new BadRequestException("A cancelled receivable cannot receive repayments");

      // Duplicate submission (double click / retry): hand back the original, write nothing.
      if (dto.idempotencyKey) {
        const existing = await tx.receivableRepayment.findFirst({ where: { receivableId: id, idempotencyKey: dto.idempotencyKey } });
        if (existing) return { duplicate: true as const, repayment: existing };
      }

      if (utcDayNumber(returnedAt) < utcDayNumber(row.givenAt)) {
        throw new BadRequestException("returnedAt cannot be before the date the money was given");
      }

      const original = toDecimal(row.originalAmount);
      const returnedBefore = await this.returnedTotal(tx, id);
      const outstanding = receivableOutstanding(original, returnedBefore);
      if (amount.gt(outstanding)) {
        throw new BadRequestException(`Cannot record ${toMoneyString(amount)}; only ${toMoneyString(outstanding)} is outstanding.`);
      }

      const repayment = await tx.receivableRepayment.create({
        data: {
          userId,
          receivableId: id,
          amount,
          returnedAt,
          paymentMethod: dto.paymentMethod,
          idempotencyKey: dto.idempotencyKey,
          notes: dto.notes,
        },
      });
      await tx.receivable.update({ where: { id }, data: { status: receivableStatusFor(original, returnedBefore.plus(amount)) } });
      return { duplicate: false as const, repayment };
    });

    if (!outcome.duplicate) {
      await this.audit.log("RECEIVABLE_REPAYMENT_RECORDED", userId, {
        receivableId: id,
        repaymentId: outcome.repayment.id,
        amount: toMoneyString(amount),
      });
    }
    return { receivable: await this.viewById(userId, id, true), repayment: this.repaymentDto(outcome.repayment), duplicate: outcome.duplicate };
  }

  /** Deliberately deletes ONE mistaken repayment and re-derives the status. */
  async removeRepayment(userId: string, id: string, repaymentId: string): Promise<ReceivableDTO> {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, `receivable:${id}`);
      const row = await tx.receivable.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundException("Receivable not found");
      const repayment = await tx.receivableRepayment.findFirst({ where: { id: repaymentId, receivableId: id, userId } });
      if (!repayment) throw new NotFoundException("Repayment not found");

      await tx.receivableRepayment.delete({ where: { id: repaymentId } });
      const returned = await this.returnedTotal(tx, id);
      await tx.receivable.update({ where: { id }, data: { status: receivableStatusFor(toDecimal(row.originalAmount), returned) } });
    });
    await this.audit.log("RECEIVABLE_REPAYMENT_DELETED", userId, { receivableId: id, repaymentId });
    return this.viewById(userId, id, true);
  }

  /** Void an entry made by mistake. Refused once repayment history exists (history is never erased). */
  async cancel(userId: string, id: string): Promise<ReceivableDTO> {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, `receivable:${id}`);
      const row = await tx.receivable.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundException("Receivable not found");
      if (row.status === "CANCELLED") return; // idempotent
      const count = await tx.receivableRepayment.count({ where: { receivableId: id } });
      if (count > 0) {
        throw new BadRequestException(
          "This receivable already has repayment history, so it cannot be cancelled. Record what remains as returned, or correct the amount if it was entered wrongly.",
        );
      }
      await tx.receivable.update({ where: { id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
    });
    await this.audit.log("RECEIVABLE_CANCELLED", userId, { receivableId: id });
    return this.viewById(userId, id, true);
  }

  /** Hard delete, only for an entry with no repayment history. */
  async remove(userId: string, id: string): Promise<{ deleted: true }> {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, `receivable:${id}`);
      const row = await tx.receivable.findFirst({ where: { id, userId } });
      if (!row) throw new NotFoundException("Receivable not found");
      const count = await tx.receivableRepayment.count({ where: { receivableId: id } });
      if (count > 0) {
        throw new BadRequestException("This receivable has repayment history and cannot be deleted. Delete the individual repayments first if they were mistakes.");
      }
      await tx.receivable.delete({ where: { id } });
    });
    await this.audit.log("RECEIVABLE_DELETED", userId, { receivableId: id });
    return { deleted: true };
  }
}
