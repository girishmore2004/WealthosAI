import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { EmergencyFundLedgerRowDTO, EmergencyFundOverviewDTO } from "@wealthos/types";
import { PrismaService } from "../../prisma/prisma.service";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import {
  emergencyRemaining,
  emergencyReserveDelta,
  emergencyTargetFromMonths,
  percentOf,
  periodsToReach,
  periodsUntil,
  requiredContribution,
  toDecimal,
  toMoneyString,
  utcDayNumber,
} from "../../common/financial-facts/financial-formulas";
import { currentMonthString, monthsBefore } from "../../common/utils/financial-period.util";
import { CreateEmergencyEntryDto } from "./dto/create-emergency-entry.dto";
import { UpdateEmergencyPlanDto, UseEmergencyMoneyDto } from "./dto/emergency-plan.dto";
import { buildLedger, buildTrend, summarizeLedger } from "./emergency-fund.util";

// Average month length, used for "months until the target date" (rounded UP, so a plan never assumes
// money arrives after its deadline).
const DAYS_PER_MONTH = 30.4375;
const TREND_MONTHS = 12;

const pct1 = (d: Prisma.Decimal | null): number | null => (d === null ? null : Number(d.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()));

// Emergency Fund is RESERVED CASH, not an expense. This service only records movements
// of money into/out of the reserve; spending released from it is a separate Expense that
// the user logs through the normal expenses flow (or, via useMoney(), in the same transaction).
//
// CONCURRENCY: every write that depends on the current reserve balance (a reduction in
// create(), any delete) runs inside ONE transaction that first takes a per-user Postgres
// advisory lock. Without it, two simultaneous withdrawals could each read the same
// balance, each pass the "enough in the reserve" check, and together overdraw the fund.
@Injectable()
export class EmergencyFundService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
  ) {}

  // Serializes balance-dependent writes for one user for the life of the transaction
  // (the lock is released automatically on commit/rollback).
  private async lockUser(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  }

  /**
   * Validates and writes ONE ledger entry inside an already-open, already-locked transaction. A
   * reduction may not exceed what the reserve holds (compared with Decimal, never floats).
   */
  private async insertEntry(
    tx: Prisma.TransactionClient,
    userId: string,
    e: { type: CreateEmergencyEntryDto["type"]; amount: number; occurredAt: Date; reason?: string; notes?: string },
  ) {
    const reducing = e.type === "RELEASE" || e.type === "WITHDRAWAL" || e.type === "TRANSFER_OUT" || (e.type === "ADJUSTMENT" && e.amount < 0);
    if (reducing) {
      const balance = await this.balance(tx, userId);
      const reduction = new Prisma.Decimal(e.amount).abs();
      if (reduction.gt(balance)) {
        throw new BadRequestException(`Cannot take ${toMoneyString(reduction)} out of the reserve; Emergency Cash is ${toMoneyString(balance)}.`);
      }
    }
    return tx.emergencyFundEntry.create({
      data: { userId, type: e.type, amount: e.amount, occurredAt: e.occurredAt, reason: e.reason, notes: e.notes },
    });
  }

  async create(userId: string, dto: CreateEmergencyEntryDto) {
    if (dto.type === "ADJUSTMENT") {
      if (dto.amount === 0) throw new BadRequestException("An adjustment cannot be zero");
    } else if (dto.amount <= 0) {
      throw new BadRequestException("amount must be greater than zero");
    }

    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");

    return this.prisma.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);
      return this.insertEntry(tx, userId, { type: dto.type, amount: dto.amount, occurredAt, reason: dto.reason, notes: dto.notes });
    });
  }

  /**
   * USE MONEY. Takes money out of the reserve (a WITHDRAWAL) and — when it was actually spent — records
   * that spending as a genuine Expense in the SAME transaction:
   *   reserve  −X   (the withdrawal is not an expense and not income)
   *   expense  +X   (the money was consumed here, and counted exactly once)
   * so a ₹10,000 medical bill paid from the fund shows ₹10,000 of medical expense once, and the fund
   * ₹10,000 lower. Without `expense` the money just leaves the reserve (e.g. moved back to savings).
   */
  async useMoney(userId: string, dto: UseEmergencyMoneyDto) {
    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");

    return this.prisma.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);

      if (dto.expense) {
        const category = await tx.category.findUnique({ where: { id: dto.expense.categoryId }, select: { type: true, name: true } });
        if (!category) throw new BadRequestException("Category not found");
        if (category.type === "SAVINGS") {
          throw new BadRequestException(`"${category.name}" is a savings/investment category and cannot be used for an expense.`);
        }
      }

      const entry = await this.insertEntry(tx, userId, { type: "WITHDRAWAL", amount: dto.amount, occurredAt, reason: dto.reason, notes: dto.notes });

      const expense = dto.expense
        ? await tx.expense.create({
            data: {
              userId,
              categoryId: dto.expense.categoryId,
              merchant: dto.expense.merchant ?? dto.reason ?? null,
              amount: dto.amount,
              spentAt: occurredAt,
              paymentMethod: "OTHER",
              notes: "Paid from emergency fund",
              flowType: "EXPENSE",
            },
          })
        : null;

      return { entry, expense };
    });
  }

  list(userId: string) {
    return this.prisma.client.emergencyFundEntry.findMany({ where: { userId }, orderBy: { occurredAt: "desc" } });
  }

  /** The history, newest first, each row with what it did to the reserve and the balance AFTER it. */
  async ledger(userId: string): Promise<EmergencyFundLedgerRowDTO[]> {
    const entries = await this.prisma.client.emergencyFundEntry.findMany({ where: { userId } });
    return buildLedger(entries).map((r) => ({
      id: r.id,
      type: r.type,
      amount: toMoneyString(r.amount),
      effect: toMoneyString(r.effect),
      balanceAfter: toMoneyString(r.balanceAfter),
      occurredAt: r.occurredAt.toISOString(),
      reason: r.reason,
      notes: r.notes,
      origin: r.origin ?? "MANUAL",
    }));
  }

  // Deleting a CONTRIBUTION-type entry (ALLOCATE / TRANSFER_IN / positive ADJUSTMENT)
  // lowers the reserve, so it is held to the same "never negative" rule as a withdrawal:
  // otherwise deleting an old allocation after money was already used would leave a
  // negative reserve. Deleting a reducing entry only ever raises the balance and is allowed.
  async remove(userId: string, id: string) {
    return this.prisma.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId);

      // Ownership enforced in the query itself; a foreign id and a missing id are the
      // same 404 (no leak of which case occurred).
      const entry = await tx.emergencyFundEntry.findFirst({ where: { id, userId } });
      if (!entry) throw new NotFoundException("Emergency fund entry not found");

      const effect = emergencyReserveDelta({ type: entry.type, amount: entry.amount });
      if (effect.gt(0)) {
        const balance = await this.balance(tx, userId);
        const after = balance.minus(effect);
        if (after.lt(0)) {
          throw new BadRequestException(
            `Deleting this entry would make the reserve negative (${toMoneyString(after)}). ` +
              "Remove or correct the later withdrawals first.",
          );
        }
      }

      const res = await tx.emergencyFundEntry.deleteMany({ where: { id, userId } });
      if (res.count === 0) throw new NotFoundException("Emergency fund entry not found");
      return { deleted: true };
    });
  }

  /** Authoritative reserve balance, derived from the ledger by the shared formula. */
  private async balance(db: Pick<Prisma.TransactionClient, "emergencyFundEntry">, userId: string): Promise<Prisma.Decimal> {
    const rows = await db.emergencyFundEntry.groupBy({
      by: ["type"],
      where: { userId },
      _sum: { amount: true },
    });
    return rows.reduce(
      (acc, r) => acc.plus(emergencyReserveDelta({ type: r.type, amount: toDecimal(r._sum.amount) })),
      new Prisma.Decimal(0),
    );
  }

  async summary(userId: string) {
    const [coverage, position] = await Promise.all([this.facts.getEmergencyCoverage(userId), this.facts.getFinancialPosition(userId)]);
    return {
      basis: "ACTUAL" as const,
      emergencyCash: position.cash.emergency,
      availableCash: position.cash.available,
      totalCash: position.cash.total,
      coverageMonths: coverage.coverageMonths,
      avgMonthlyEssentialExpenses: coverage.avgMonthlyEssentialExpenses,
      monthsOfData: coverage.monthsOfData,
    };
  }

  // --- target & contribution plan ------------------------------------------------------------

  getPlan(userId: string) {
    return this.prisma.client.emergencyFundPlan.findUnique({ where: { userId } });
  }

  /**
   * Sets the target (an amount OR months of essential expenses — never both) and the contribution plan.
   * Omitted fields are left alone; null clears. Sending one kind of target clears the other.
   */
  async updatePlan(userId: string, dto: UpdateEmergencyPlanDto, now: Date = new Date()) {
    if (dto.targetAmount != null && dto.targetMonths != null) {
      throw new BadRequestException("Choose either a target amount or a number of months of expenses, not both.");
    }

    const data: Prisma.EmergencyFundPlanUncheckedUpdateInput = {};
    if (dto.targetAmount !== undefined) {
      data.targetAmount = dto.targetAmount;
      if (dto.targetAmount !== null) data.targetMonths = null;
    }
    if (dto.targetMonths !== undefined) {
      data.targetMonths = dto.targetMonths;
      if (dto.targetMonths !== null) data.targetAmount = null;
    }
    if (dto.monthlyContribution !== undefined) data.monthlyContribution = dto.monthlyContribution;
    if (dto.targetDate !== undefined) {
      if (dto.targetDate === null) data.targetDate = null;
      else {
        const d = new Date(dto.targetDate);
        if (Number.isNaN(d.getTime())) throw new BadRequestException("Invalid targetDate");
        if (utcDayNumber(d) < utcDayNumber(now)) throw new BadRequestException("The target date cannot be in the past.");
        data.targetDate = d;
      }
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("Nothing to change");

    return this.prisma.client.emergencyFundPlan.upsert({
      where: { userId },
      create: { ...(data as Prisma.EmergencyFundPlanUncheckedCreateInput), userId },
      update: data,
    });
  }

  // --- overview -------------------------------------------------------------------------------

  /**
   * Everything the Emergency Fund page and dashboard card show, in ONE response and computed ONLY here.
   * The balance and coverage come from FinancialFactsService (so they match every other page); target,
   * progress and the contribution plan use the shared formulas; nothing is calculated in the browser.
   *
   * Labels: balance / coverage / totals are ACTUAL; the target is a TARGET; required contributions and
   * the estimated finish are ESTIMATED planning calculations (never recommendations).
   */
  async overview(userId: string, now: Date = new Date()): Promise<EmergencyFundOverviewDTO> {
    const [coverage, entries, plan] = await Promise.all([
      this.facts.getEmergencyCoverage(userId),
      this.prisma.client.emergencyFundEntry.findMany({ where: { userId } }),
      this.prisma.client.emergencyFundPlan.findUnique({ where: { userId } }),
    ]);

    const currentMonth = currentMonthString(now);
    const totals = summarizeLedger(entries, currentMonth);
    const balance = toDecimal(coverage.emergencyCash);
    const avgEssential = toDecimal(coverage.avgMonthlyEssentialExpenses);

    // Target: months win only if set (the service keeps the two mutually exclusive).
    const mode = plan?.targetMonths != null ? "MONTHS" : plan?.targetAmount != null ? "AMOUNT" : null;
    const targetAmount =
      mode === "MONTHS" ? emergencyTargetFromMonths(toDecimal(plan!.targetMonths), avgEssential) : mode === "AMOUNT" ? toDecimal(plan!.targetAmount) : null;

    const remaining = targetAmount ? emergencyRemaining(targetAmount, balance) : null;
    const reached = targetAmount ? balance.gte(targetAmount) : false;
    const progress = targetAmount ? percentOf(balance, targetAmount) : null;

    // Contribution plan.
    const targetDate = plan?.targetDate ?? null;
    const monthsLeft = targetDate ? periodsUntil(targetDate, now, DAYS_PER_MONTH) : null;
    const weeksLeft = targetDate ? periodsUntil(targetDate, now, 7) : null;
    const requiredMonthly = remaining && monthsLeft !== null ? requiredContribution(remaining, monthsLeft) : null;
    const requiredWeekly = remaining && weeksLeft !== null ? requiredContribution(remaining, weeksLeft) : null;
    const planned = plan?.monthlyContribution != null ? toDecimal(plan.monthlyContribution) : null;
    const monthsToTarget = remaining && planned ? periodsToReach(remaining, planned) : null;
    const estimatedFinish =
      monthsToTarget !== null && monthsToTarget > 0 ? new Date(now.getTime() + monthsToTarget * DAYS_PER_MONTH * 86_400_000).toISOString() : null;

    const months = Array.from({ length: TREND_MONTHS }, (_, i) => monthsBefore(currentMonth, TREND_MONTHS - 1 - i));
    const trend = buildTrend(entries, months);

    const money = (d: Prisma.Decimal | null) => (d === null ? null : toMoneyString(d));
    const point = (p: { occurredAt: Date; amount: Prisma.Decimal } | null) => (p ? { date: p.occurredAt.toISOString(), amount: toMoneyString(p.amount) } : null);

    return {
      basis: "ACTUAL",
      currency: "INR",
      balance: toMoneyString(balance),
      coverage: { months: coverage.coverageMonths, avgMonthlyEssentialExpenses: coverage.avgMonthlyEssentialExpenses, monthsOfData: coverage.monthsOfData },
      target: {
        basis: "TARGET",
        mode,
        amount: money(targetAmount),
        months: plan?.targetMonths != null ? toDecimal(plan.targetMonths).toString() : null,
        // Months were chosen but there is no essential-spending history yet to turn them into rupees.
        needsExpenseHistory: mode === "MONTHS" && targetAmount === null,
      },
      progress: { percent: pct1(progress), remaining: money(remaining), reached },
      plan: {
        basis: "ESTIMATED",
        monthlyContribution: money(planned),
        targetDate: targetDate ? targetDate.toISOString() : null,
        requiredMonthly: money(requiredMonthly),
        requiredWeekly: money(requiredWeekly),
        monthsToTargetAtPlan: monthsToTarget,
        estimatedFinishDate: estimatedFinish,
      },
      totals: {
        contributions: toMoneyString(totals.contributions),
        withdrawals: toMoneyString(totals.withdrawals),
        adjustments: toMoneyString(totals.adjustments),
        contributedThisMonth: toMoneyString(totals.contributionsThisMonth),
        contributedThisYear: toMoneyString(totals.contributionsThisYear),
        withdrawnThisYear: toMoneyString(totals.withdrawalsThisYear),
      },
      last: { contribution: point(totals.lastContribution), withdrawal: point(totals.lastWithdrawal) },
      trend: trend.map((t) => ({ month: t.month, closingBalance: toMoneyString(t.closingBalance), added: toMoneyString(t.added), used: toMoneyString(t.used) })),
      entryCount: entries.length,
    };
  }
}
