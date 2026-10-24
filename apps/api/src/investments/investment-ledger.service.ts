import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { PagedInvestmentTransactionsDTO, SipChangeDTO, SipInstallmentDTO, SipScheduleSummaryDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { isUniqueViolation } from "../common/utils/prisma-errors.util";
import { CreateCashflowDto } from "./dto/create-cashflow.dto";
import { CreateValuationDto } from "./dto/create-valuation.dto";
import { SipScheduleDto } from "./dto/sip-schedule.dto";
import { UpdateCashflowDto } from "./dto/update-cashflow.dto";
import { SipInstallmentDto } from "./dto/sip-installment.dto";
import { ListTransactionsQueryDto } from "./dto/list-transactions-query.dto";
import { AuditService } from "../audit/audit.service";
import { sipStatusOf } from "./investment-returns.util";
import { annualContribution, monthlyEquivalent, toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import {
  InvestmentTypeName,
  SipFrequency,
  countSipOccurrences,
  dueSipPeriods,
  maxPeriodsPerRun,
  nextSipOccurrence,
  sipOccurrences,
  sipPeriodKeyFor,
  supportsContributionSchedule,
  validateCashflowForType,
} from "./investment-sip.util";

export interface SipGenerationResult {
  investmentId: string;
  created: string[]; // period keys
  alreadyExisted: string[];
  // Periods deliberately NOT created because the user recorded them as skipped / failed / pending.
  held: string[];
}

const DAY_MS = 86_400_000;
const MAX_FUTURE_DAYS = 1; // absorbs client/server timezone drift; anything later has not happened yet

// Dated cashflows + valuations + SIP schedule for investments. Every method is scoped by
// the authenticated userId and verifies ownership of the investment server-side. All
// derived numbers (net contributions, gains, returns) come from FinancialFactsService —
// profit is never accepted from the client.
@Injectable()
export class InvestmentLedgerService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
    @Optional() private audit?: AuditService,
  ) {}

  // Best-effort audit trail: a logging failure must never undo or block a financial write.
  private async record(action: string, userId: string, metadata: Prisma.InputJsonValue) {
    try {
      await this.audit?.log(action, userId, metadata);
    } catch {
      /* swallowed on purpose */
    }
  }

  private assertNotFuture(d: Date, label: string) {
    if (d.getTime() > Date.now() + MAX_FUTURE_DAYS * DAY_MS) {
      throw new BadRequestException(`${label} cannot be in the future — a contribution or payout that has not happened yet is not recorded as one.`);
    }
  }

  private async owned(userId: string, investmentId: string) {
    const inv = await this.prisma.client.investment.findFirst({
      where: { id: investmentId, userId },
      select: { id: true, name: true, type: true, purchaseDate: true, monthlyContribution: true, contributionDay: true, contributionStartDate: true, contributionEndDate: true, sipActive: true, sipPausedAt: true, sipCancelledAt: true, contributionFrequency: true, expectedAnnualReturn: true },
    });
    if (!inv) throw new NotFoundException("Investment not found");
    return inv;
  }

  async addCashflow(userId: string, investmentId: string, dto: CreateCashflowDto) {
    const inv = await this.owned(userId, investmentId);
    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");
    this.assertNotFuture(occurredAt, "The transaction date");
    const typeError = validateCashflowForType(inv.type as InvestmentTypeName, dto.type);
    if (typeError) throw new BadRequestException(typeError);

    // Duplicate guard: the same type and amount on the same day is almost always a double entry (a
    // retried request, or a bank line entered twice). The caller can override it explicitly.
    if (!dto.allowDuplicate) {
      const dayStart = new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), occurredAt.getUTCDate()));
      const twin = await this.prisma.client.investmentCashflow.findFirst({
        where: { userId, investmentId, type: dto.type, amount: dto.amount, occurredAt: { gte: dayStart, lt: new Date(dayStart.getTime() + DAY_MS) } },
        select: { id: true },
      });
      if (twin) {
        throw new ConflictException("An identical entry (same type, amount and date) already exists. If this is a genuine second one, submit it again with allowDuplicate set.");
      }
    }

    const created = await this.prisma.client.investmentCashflow.create({
      data: { userId, investmentId, type: dto.type, amount: dto.amount, occurredAt, notes: dto.notes, origin: "MANUAL" },
    });
    await this.record("investment.cashflow.create", userId, { investmentId, cashflowId: created.id, type: dto.type, amount: dto.amount });
    return created;
  }

  // Correct an existing entry. Generated (period-keyed) rows keep their date, because the date is part of
  // what makes them idempotent; their amount and note can still be corrected. Both the before and after
  // values are written to the audit log.
  async updateCashflow(userId: string, investmentId: string, cashflowId: string, dto: UpdateCashflowDto) {
    await this.owned(userId, investmentId);
    const existing = await this.prisma.client.investmentCashflow.findFirst({ where: { id: cashflowId, investmentId, userId } });
    if (!existing) throw new NotFoundException("Cashflow not found");
    if (dto.amount === undefined && dto.occurredAt === undefined && dto.notes === undefined) throw new BadRequestException("Nothing to change.");

    let occurredAt: Date | undefined;
    if (dto.occurredAt !== undefined) {
      occurredAt = new Date(dto.occurredAt);
      if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");
      this.assertNotFuture(occurredAt, "The transaction date");
      if (existing.periodKey && occurredAt.getTime() !== existing.occurredAt.getTime()) {
        throw new BadRequestException("The date of a schedule-generated entry cannot be changed. Edit its amount or delete it instead.");
      }
    }

    const updated = await this.prisma.client.investmentCashflow.update({
      where: { id: cashflowId },
      data: { ...(dto.amount !== undefined ? { amount: dto.amount } : {}), ...(occurredAt ? { occurredAt } : {}), ...(dto.notes !== undefined ? { notes: dto.notes } : {}) },
    });
    await this.record("investment.cashflow.update", userId, {
      investmentId,
      cashflowId,
      before: { amount: existing.amount.toString(), occurredAt: existing.occurredAt.toISOString(), notes: existing.notes },
      after: { amount: updated.amount.toString(), occurredAt: updated.occurredAt.toISOString(), notes: updated.notes },
    });
    return updated;
  }

  // The portfolio-wide ledger: every holding's transactions, filtered, searched, sorted and paged in the
  // database. Totals cover the WHOLE filtered set so the footer is right on every page.
  async listTransactions(userId: string, q: ListTransactionsQueryDto): Promise<PagedInvestmentTransactionsDTO> {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 25;
    const where: Prisma.InvestmentCashflowWhereInput = {
      userId,
      ...(q.type ? { type: q.type } : {}),
      ...(q.investmentId ? { investmentId: q.investmentId } : {}),
      ...(q.from || q.to
        ? { occurredAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } }
        : {}),
      ...(q.q
        ? { OR: [{ notes: { contains: q.q, mode: "insensitive" } }, { investment: { name: { contains: q.q, mode: "insensitive" } } }] }
        : {}),
    };
    const orderBy: Prisma.InvestmentCashflowOrderByWithRelationInput[] =
      q.sort === "date_asc" ? [{ occurredAt: "asc" }, { id: "asc" }]
      : q.sort === "amount_desc" ? [{ amount: "desc" }, { id: "asc" }]
      : q.sort === "amount_asc" ? [{ amount: "asc" }, { id: "asc" }]
      : [{ occurredAt: "desc" }, { id: "desc" }];

    const [rows, total, sums] = await Promise.all([
      this.prisma.client.investmentCashflow.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { investment: { select: { name: true, type: true } } },
      }),
      this.prisma.client.investmentCashflow.count({ where }),
      this.prisma.client.investmentCashflow.groupBy({ by: ["type"], where, _sum: { amount: true } }),
    ]);
    const sum = (types: string[]) => sums.filter((r) => types.includes(r.type)).reduce((acc, r) => acc.plus(toDecimal(r._sum.amount)), toDecimal(0));
    return {
      items: rows.map((r) => ({
        id: r.id,
        investmentId: r.investmentId,
        investmentName: r.investment.name,
        investmentType: r.investment.type,
        type: r.type,
        amount: toMoneyString(toDecimal(r.amount)),
        occurredAt: r.occurredAt.toISOString(),
        origin: r.origin,
        periodKey: r.periodKey,
        notes: r.notes,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      totals: { contributed: toMoneyString(sum(["CONTRIBUTION", "EMPLOYER_CONTRIBUTION"])), withdrawn: toMoneyString(sum(["WITHDRAWAL", "SALE"])) },
    };
  }

  async listCashflows(userId: string, investmentId: string) {
    await this.owned(userId, investmentId);
    return this.prisma.client.investmentCashflow.findMany({ where: { userId, investmentId }, orderBy: { occurredAt: "desc" } });
  }

  async removeCashflow(userId: string, investmentId: string, cashflowId: string) {
    const res = await this.prisma.client.investmentCashflow.deleteMany({ where: { id: cashflowId, investmentId, userId } });
    if (res.count === 0) throw new NotFoundException("Cashflow not found");
    return { deleted: true };
  }

  async addValuation(userId: string, investmentId: string, dto: CreateValuationDto) {
    await this.owned(userId, investmentId);
    const valuedAt = new Date(dto.valuedAt);
    if (Number.isNaN(valuedAt.getTime())) throw new BadRequestException("Invalid valuedAt date");
    if (valuedAt.getTime() > Date.now() + 86_400_000) throw new BadRequestException("valuedAt cannot be in the future");

    // One valuation per (investment, date): re-submitting a date corrects it rather than
    // creating a conflicting second value for the same day.
    //
    // WRITE-THROUGH: Investment.currentValue is still read directly by the legacy
    // summary, the dashboard's investmentsValue, the yearly report and Goals, while Net
    // Worth reads the latest valuation. Without syncing, the two disagree the moment a
    // valuation is recorded. The valuation row and the legacy field are updated in one
    // transaction, and only when this valuation is the LATEST one — back-dating an older
    // valuation must not roll the current value backwards.
    return this.prisma.client.$transaction(async (tx) => {
      const saved = await tx.investmentValuation.upsert({
        where: { investmentId_valuedAt: { investmentId, valuedAt } },
        create: { userId, investmentId, value: dto.value, valuedAt, origin: "MANUAL" },
        update: { value: dto.value, origin: "MANUAL" },
      });

      const latest = await tx.investmentValuation.findFirst({
        where: { userId, investmentId },
        orderBy: { valuedAt: "desc" },
        select: { id: true, value: true },
      });
      if (latest && latest.id === saved.id) {
        await tx.investment.updateMany({ where: { id: investmentId, userId }, data: { currentValue: latest.value } });
      }

      return saved;
    });
  }

  async listValuations(userId: string, investmentId: string) {
    await this.owned(userId, investmentId);
    return this.prisma.client.investmentValuation.findMany({ where: { userId, investmentId }, orderBy: { valuedAt: "desc" } });
  }

  async metrics(userId: string, investmentId: string) {
    await this.owned(userId, investmentId);
    return this.facts.getInvestmentSummary(userId, investmentId);
  }

  // --- SIP schedule: amount history, lifecycle ---------------------------------------------------

  // The amount that applied to a contribution dated `at`: the latest recorded change at or before it,
  // else the EARLIEST recorded amount (a back-dated schedule), else the schedule's current amount.
  private amountFor(changes: Array<{ effectiveFrom: Date; amountPerPeriod: Prisma.Decimal.Value }>, at: Date, current: Prisma.Decimal.Value): Prisma.Decimal.Value {
    if (changes.length === 0) return current;
    let chosen = changes[0];
    for (const c of changes) if (c.effectiveFrom.getTime() <= at.getTime()) chosen = c;
    return chosen.amountPerPeriod;
  }

  private scheduleOf(inv: { contributionFrequency: string | null; contributionDay: number | null; contributionStartDate: Date | null; contributionEndDate: Date | null }) {
    const frequency = (inv.contributionFrequency ?? "MONTHLY") as SipFrequency;
    return { frequency, contributionDay: inv.contributionDay ?? inv.contributionStartDate?.getUTCDate() ?? 1, startDate: inv.contributionStartDate as Date, endDate: inv.contributionEndDate };
  }

  // Marks the instalments that fell due while a schedule was paused or cancelled as SKIPPED, so that
  // resuming it never back-fills them as if they had been paid. Idempotent; never touches a period that
  // already has a contribution or an outcome.
  private async holdGapPeriods(userId: string, inv: Awaited<ReturnType<InvestmentLedgerService["owned"]>>, from: Date, to: Date): Promise<string[]> {
    if (!inv.monthlyContribution || !inv.contributionStartDate) return [];
    const schedule = this.scheduleOf(inv);
    const gap = sipOccurrences(schedule, to)
      .filter((d) => d.getTime() >= from.getTime() && d.getTime() <= to.getTime())
      .slice(-maxPeriodsPerRun(schedule.frequency));
    if (gap.length === 0) return [];
    const keyed = gap.map((d) => ({ key: sipPeriodKeyFor(schedule.frequency, d), date: d }));
    const [cash, events] = await Promise.all([
      this.prisma.client.investmentCashflow.findMany({ where: { investmentId: inv.id, userId, type: "CONTRIBUTION", occurredAt: { gte: gap[0] } }, select: { periodKey: true, occurredAt: true } }),
      this.prisma.client.sipInstallmentEvent.findMany({ where: { investmentId: inv.id, periodKey: { in: keyed.map((k) => k.key) } }, select: { periodKey: true } }),
    ]);
    const taken = new Set<string>([...events.map((e) => e.periodKey), ...cash.map((c) => c.periodKey ?? sipPeriodKeyFor(schedule.frequency, c.occurredAt))]);
    const fresh = keyed.filter((k) => !taken.has(k.key));
    if (fresh.length === 0) return [];
    await this.prisma.client.sipInstallmentEvent.createMany({
      data: fresh.map((k) => ({ userId, investmentId: inv.id, periodKey: k.key, status: "SKIPPED" as const, scheduledFor: k.date, notes: "Not made while the schedule was paused" })),
      skipDuplicates: true,
    });
    return fresh.map((k) => k.key);
  }

  private async logChange(userId: string, investmentId: string, effectiveFrom: Date, amount: Prisma.Decimal.Value, frequency: SipFrequency, reason: string) {
    await this.prisma.client.investmentSipChange.create({ data: { userId, investmentId, effectiveFrom, amountPerPeriod: amount, frequency, reason } });
  }

  async setSipSchedule(userId: string, investmentId: string, dto: SipScheduleDto) {
    const inv = await this.owned(userId, investmentId);
    if (!supportsContributionSchedule(inv.type as InvestmentTypeName)) {
      throw new BadRequestException(`A recurring contribution schedule does not apply to ${inv.type} investments.`);
    }
    const startDate = new Date(dto.startDate);
    const endDate = dto.endDate ? new Date(dto.endDate) : null;
    if (Number.isNaN(startDate.getTime()) || (endDate && Number.isNaN(endDate.getTime()))) {
      throw new BadRequestException("Invalid start or end date");
    }
    if (endDate && endDate < startDate) throw new BadRequestException("endDate cannot be before startDate");

    const now = new Date();
    const currentMonthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    if (dto.active && startDate.getTime() < currentMonthStart && !dto.confirmBackfill) {
      throw new BadRequestException(
        "This start date is before the current month, so activating it will record past contributions as actual cashflows. Re-submit with confirmBackfill: true to confirm.",
      );
    }
    const effectiveFrom = dto.effectiveFrom ? new Date(dto.effectiveFrom) : now;
    if (Number.isNaN(effectiveFrom.getTime())) throw new BadRequestException("Invalid effectiveFrom date");

    // MONTHLY is the default, so every existing client (which never sends a frequency) behaves
    // exactly as before. WEEKLY / BIWEEKLY repeat from the start date and have no day of month.
    const frequency: SipFrequency = dto.frequency ?? "MONTHLY";
    const usesDayOfMonth = frequency === "MONTHLY" || frequency === "QUARTERLY" || frequency === "YEARLY";
    const contributionDay = usesDayOfMonth ? (dto.contributionDay ?? startDate.getUTCDate()) : null;

    // What kind of change is this? A step-up / step-down / frequency change is recorded in the history so
    // the contributions made under the old plan keep the old amount.
    const prevAmount = inv.monthlyContribution ? toDecimal(inv.monthlyContribution) : null;
    const nextAmount = toDecimal(dto.monthlyContribution);
    let reason: string | null = null;
    if (prevAmount === null) reason = "CREATED";
    else if (!prevAmount.equals(nextAmount)) reason = nextAmount.greaterThan(prevAmount) ? "STEP_UP" : "STEP_DOWN";
    else if (inv.contributionFrequency !== frequency) reason = "FREQUENCY_CHANGE";

    // Re-activating a paused / cancelled schedule must not back-fill what was missed while it was off.
    const wasOff = !inv.sipActive && !!inv.monthlyContribution;
    if (dto.active && wasOff) {
      const from = inv.sipPausedAt ?? inv.sipCancelledAt;
      if (from) await this.holdGapPeriods(userId, inv, from, now);
    }

    const updated = await this.prisma.client.investment.update({
      where: { id: investmentId },
      data: {
        monthlyContribution: dto.monthlyContribution,
        contributionDay,
        contributionFrequency: frequency,
        contributionStartDate: startDate,
        contributionEndDate: endDate,
        sipActive: dto.active,
        sipPausedAt: dto.active ? null : (inv.sipPausedAt ?? now),
        sipCancelledAt: dto.active ? null : inv.sipCancelledAt,
        // Only written when supplied: an assumption for projections, never an actual value.
        ...(dto.expectedAnnualReturn !== undefined ? { expectedAnnualReturn: dto.expectedAnnualReturn } : {}),
      },
    });
    if (reason) await this.logChange(userId, investmentId, reason === "CREATED" ? startDate : effectiveFrom, dto.monthlyContribution, frequency, reason);
    await this.record("investment.sip.set", userId, { investmentId, reason, amount: dto.monthlyContribution, frequency, active: dto.active });
    return updated;
  }

  async pauseSip(userId: string, investmentId: string) {
    const inv = await this.owned(userId, investmentId);
    const status = this.statusOf(inv);
    if (status === "NONE") throw new BadRequestException("There is no recurring schedule to pause.");
    if (status === "CANCELLED" || status === "COMPLETED") throw new BadRequestException(`This schedule is ${status.toLowerCase()} and cannot be paused.`);
    if (!inv.sipActive) throw new BadRequestException("This schedule is already paused.");
    const now = new Date();
    await this.prisma.client.investment.update({ where: { id: investmentId }, data: { sipActive: false, sipPausedAt: now } });
    await this.logChange(userId, investmentId, now, inv.monthlyContribution as Prisma.Decimal.Value, (inv.contributionFrequency ?? "MONTHLY") as SipFrequency, "PAUSED");
    await this.record("investment.sip.pause", userId, { investmentId });
    return this.getSipSchedule(userId, investmentId);
  }

  async resumeSip(userId: string, investmentId: string) {
    const inv = await this.owned(userId, investmentId);
    const status = this.statusOf(inv);
    if (status === "NONE") throw new BadRequestException("There is no recurring schedule to resume.");
    if (status === "CANCELLED") throw new BadRequestException("A cancelled schedule cannot be resumed. Set up a new schedule instead.");
    if (status === "COMPLETED") throw new BadRequestException("This schedule has reached its end date. Edit the end date to continue it.");
    if (inv.sipActive) throw new BadRequestException("This schedule is already active.");
    const now = new Date();
    // The instalments that fell due while paused are recorded as skipped, never back-filled as paid.
    const held = inv.sipPausedAt ? await this.holdGapPeriods(userId, inv, inv.sipPausedAt, now) : [];
    await this.prisma.client.investment.update({ where: { id: investmentId }, data: { sipActive: true, sipPausedAt: null } });
    await this.logChange(userId, investmentId, now, inv.monthlyContribution as Prisma.Decimal.Value, (inv.contributionFrequency ?? "MONTHLY") as SipFrequency, "RESUMED");
    await this.record("investment.sip.resume", userId, { investmentId, skippedWhilePaused: held });
    return this.getSipSchedule(userId, investmentId);
  }

  async cancelSip(userId: string, investmentId: string) {
    const inv = await this.owned(userId, investmentId);
    const status = this.statusOf(inv);
    if (status === "NONE") throw new BadRequestException("There is no recurring schedule to cancel.");
    if (status === "CANCELLED") throw new BadRequestException("This schedule is already cancelled.");
    const now = new Date();
    // Cancelling keeps every contribution already recorded; it only stops future ones.
    const endDate = inv.contributionEndDate && inv.contributionEndDate.getTime() < now.getTime() ? inv.contributionEndDate : now;
    await this.prisma.client.investment.update({ where: { id: investmentId }, data: { sipActive: false, sipPausedAt: null, sipCancelledAt: now, contributionEndDate: endDate } });
    await this.logChange(userId, investmentId, now, inv.monthlyContribution as Prisma.Decimal.Value, (inv.contributionFrequency ?? "MONTHLY") as SipFrequency, "CANCELLED");
    await this.record("investment.sip.cancel", userId, { investmentId });
    return this.getSipSchedule(userId, investmentId);
  }

  private statusOf(inv: { monthlyContribution: unknown; contributionStartDate: Date | null; sipActive: boolean; contributionEndDate: Date | null; sipCancelledAt: Date | null }, asOf: Date = new Date()) {
    return sipStatusOf({ hasSchedule: !!inv.monthlyContribution && !!inv.contributionStartDate, active: inv.sipActive, endDate: inv.contributionEndDate, cancelledAt: inv.sipCancelledAt }, asOf);
  }

  async listSipChanges(userId: string, investmentId: string): Promise<SipChangeDTO[]> {
    await this.owned(userId, investmentId);
    const rows = await this.prisma.client.investmentSipChange.findMany({ where: { userId, investmentId }, orderBy: { effectiveFrom: "desc" } });
    return rows.map((r) => ({ id: r.id, effectiveFrom: r.effectiveFrom.toISOString(), amountPerPeriod: toMoneyString(toDecimal(r.amountPerPeriod)), frequency: r.frequency, reason: r.reason }));
  }

  // The schedule plus everything derived from it: next date, monthly/annual equivalents, planned vs
  // due vs remaining counts, and what has actually been recorded. All maths is deterministic and
  // lives in the SIP util / financial-formulas — nothing here is a forecast of returns.
  async getSipSchedule(userId: string, investmentId: string, asOf: Date = new Date()): Promise<SipScheduleSummaryDTO> {
    const inv = await this.owned(userId, investmentId);
    const frequency = (inv.contributionFrequency ?? "MONTHLY") as SipFrequency;
    const base: SipScheduleSummaryDTO = {
      investmentId,
      active: inv.sipActive,
      status: this.statusOf(inv, asOf),
      pausedAt: inv.sipPausedAt ? inv.sipPausedAt.toISOString() : null,
      cancelledAt: inv.sipCancelledAt ? inv.sipCancelledAt.toISOString() : null,
      frequency,
      amountPerPeriod: inv.monthlyContribution ? toMoneyString(toDecimal(inv.monthlyContribution)) : null,
      contributionDay: inv.contributionDay ?? null,
      startDate: inv.contributionStartDate ? inv.contributionStartDate.toISOString() : null,
      endDate: inv.contributionEndDate ? inv.contributionEndDate.toISOString() : null,
      expectedAnnualReturn: inv.expectedAnnualReturn ? toDecimal(inv.expectedAnnualReturn).toString() : null,
      monthlyEquivalent: null,
      annualContribution: null,
      nextContributionDate: null,
      plannedCount: null,
      dueSoFarCount: 0,
      remainingCount: null,
      plannedTotal: null,
      actualCount: 0,
      actualAmount: "0.00",
    };

    const actual = await this.prisma.client.investmentCashflow.aggregate({
      where: { userId, investmentId, type: "CONTRIBUTION" },
      _sum: { amount: true },
      _count: { _all: true },
    });
    base.actualCount = actual._count._all;
    base.actualAmount = toMoneyString(toDecimal(actual._sum.amount));

    if (!inv.monthlyContribution || !inv.contributionStartDate) return base;
    const amount = toDecimal(inv.monthlyContribution);
    base.monthlyEquivalent = toMoneyString(monthlyEquivalent(amount, frequency));
    base.annualContribution = toMoneyString(annualContribution(amount, frequency));

    const schedule = {
      frequency,
      contributionDay: inv.contributionDay ?? inv.contributionStartDate.getUTCDate(),
      startDate: inv.contributionStartDate,
      endDate: inv.contributionEndDate,
    };
    base.dueSoFarCount = countSipOccurrences(schedule, asOf);
    if (inv.contributionEndDate) {
      base.plannedCount = countSipOccurrences(schedule, inv.contributionEndDate);
      base.remainingCount = Math.max(0, base.plannedCount - base.dueSoFarCount);
      base.plannedTotal = toMoneyString(amount.times(base.plannedCount));
    }
    // An inactive schedule has no "next" contribution.
    if (inv.sipActive) base.nextContributionDate = nextSipOccurrence(schedule, asOf)?.toISOString() ?? null;
    return base;
  }

  // --- Instalments: what each scheduled date actually became -----------------------------------------

  async listSipInstallments(userId: string, investmentId: string, asOf: Date = new Date()): Promise<SipInstallmentDTO[]> {
    const inv = await this.owned(userId, investmentId);
    if (!inv.monthlyContribution || !inv.contributionStartDate) return [];
    const schedule = this.scheduleOf(inv);
    const past = sipOccurrences(schedule, asOf).slice(-24);
    const upcoming = inv.sipActive ? nextSipOccurrence(schedule, new Date(asOf.getTime() + DAY_MS)) : null;
    const dates = upcoming ? [...past, upcoming] : past;
    if (dates.length === 0) return [];

    const [cash, events, changes] = await Promise.all([
      this.prisma.client.investmentCashflow.findMany({ where: { userId, investmentId, type: "CONTRIBUTION", occurredAt: { gte: dates[0] } }, select: { id: true, amount: true, periodKey: true, occurredAt: true } }),
      this.prisma.client.sipInstallmentEvent.findMany({ where: { userId, investmentId }, select: { periodKey: true, status: true, notes: true } }),
      this.prisma.client.investmentSipChange.findMany({ where: { userId, investmentId }, orderBy: { effectiveFrom: "asc" }, select: { effectiveFrom: true, amountPerPeriod: true } }),
    ]);
    const cashByKey = new Map<string, { id: string; amount: Prisma.Decimal }>();
    for (const c of cash) {
      const key = c.periodKey ?? sipPeriodKeyFor(schedule.frequency, c.occurredAt);
      const cur = cashByKey.get(key);
      cashByKey.set(key, { id: cur?.id ?? c.id, amount: toDecimal(cur?.amount).plus(toDecimal(c.amount)) });
    }
    const eventByKey = new Map(events.map((e) => [e.periodKey, e]));

    return dates
      .map((d): SipInstallmentDTO => {
        const key = sipPeriodKeyFor(schedule.frequency, d);
        const paid = cashByKey.get(key);
        const ev = eventByKey.get(key);
        const planned = toMoneyString(toDecimal(this.amountFor(changes, d, inv.monthlyContribution as Prisma.Decimal.Value)));
        if (paid) return { periodKey: key, scheduledFor: d.toISOString(), state: "RECORDED", amount: toMoneyString(paid.amount), cashflowId: paid.id, notes: null };
        if (ev) return { periodKey: key, scheduledFor: d.toISOString(), state: ev.status, amount: planned, cashflowId: null, notes: ev.notes };
        return { periodKey: key, scheduledFor: d.toISOString(), state: d.getTime() <= asOf.getTime() ? "DUE" : "UPCOMING", amount: planned, cashflowId: null, notes: null };
      })
      .reverse();
  }

  // Record what happened to ONE due instalment. CONFIRMED creates the contribution (idempotent on the
  // period key); PENDING / SKIPPED / FAILED are remembered but never count as invested, and stop the
  // schedule from creating that period on its own.
  async recordSipInstallment(userId: string, investmentId: string, dto: SipInstallmentDto, asOf: Date = new Date()) {
    const inv = await this.owned(userId, investmentId);
    if (!inv.monthlyContribution || !inv.contributionStartDate) throw new BadRequestException("There is no recurring schedule on this investment.");
    const schedule = this.scheduleOf(inv);
    const occurrence = sipOccurrences(schedule, asOf).find((d) => sipPeriodKeyFor(schedule.frequency, d) === dto.periodKey);
    if (!occurrence) throw new BadRequestException("That period is not a due instalment of this schedule.");

    const paidRows = await this.prisma.client.investmentCashflow.findMany({
      where: { userId, investmentId, type: "CONTRIBUTION", occurredAt: { gte: new Date(occurrence.getTime() - 40 * DAY_MS) } },
      select: { periodKey: true, occurredAt: true },
    });
    const alreadyPaid = paidRows.some((c) => (c.periodKey ?? sipPeriodKeyFor(schedule.frequency, c.occurredAt)) === dto.periodKey);
    if (alreadyPaid) throw new ConflictException("A contribution is already recorded for that instalment.");

    if (dto.status === "CONFIRMED") {
      const changes = await this.prisma.client.investmentSipChange.findMany({ where: { userId, investmentId }, orderBy: { effectiveFrom: "asc" }, select: { effectiveFrom: true, amountPerPeriod: true } });
      const amount = dto.amount ?? toDecimal(this.amountFor(changes, occurrence, inv.monthlyContribution)).toNumber();
      try {
        const cashflow = await this.prisma.client.$transaction(async (tx) => {
          await tx.sipInstallmentEvent.deleteMany({ where: { investmentId, periodKey: dto.periodKey } });
          return tx.investmentCashflow.create({
            data: { userId, investmentId, type: "CONTRIBUTION", amount, occurredAt: occurrence, periodKey: dto.periodKey, origin: "MANUAL", notes: dto.notes ?? "Instalment confirmed" },
          });
        });
        await this.record("investment.sip.installment", userId, { investmentId, periodKey: dto.periodKey, status: dto.status, amount });
        return { periodKey: dto.periodKey, status: dto.status, cashflowId: cashflow.id };
      } catch (err) {
        if (isUniqueViolation(err)) throw new ConflictException("A contribution is already recorded for that instalment.");
        throw err;
      }
    }

    await this.prisma.client.sipInstallmentEvent.upsert({
      where: { investmentId_periodKey: { investmentId, periodKey: dto.periodKey } },
      create: { userId, investmentId, periodKey: dto.periodKey, status: dto.status, scheduledFor: occurrence, notes: dto.notes },
      update: { status: dto.status, notes: dto.notes },
    });
    await this.record("investment.sip.installment", userId, { investmentId, periodKey: dto.periodKey, status: dto.status });
    return { periodKey: dto.periodKey, status: dto.status, cashflowId: null };
  }

  // Materializes due contribution rows for ONE investment. Idempotent: the deterministic
  // key is (investmentId, CONTRIBUTION, periodKey); existing keys are skipped up front and a
  // concurrent insert that still collides on the unique index is treated as "already
  // existed". Re-running never creates a second row, and generated rows are plain cashflows —
  // they can never become templates themselves. Periods the user recorded as skipped / failed /
  // pending are held back, and each period uses the amount that applied on its date.
  async generateSipContributions(userId: string, investmentId: string, asOf: Date = new Date()): Promise<SipGenerationResult> {
    const inv = await this.owned(userId, investmentId);
    const result: SipGenerationResult = { investmentId, created: [], alreadyExisted: [], held: [] };
    if (!inv.sipActive || !inv.monthlyContribution || !inv.contributionStartDate) return result;

    const frequency = (inv.contributionFrequency ?? "MONTHLY") as SipFrequency;
    // Weekly / biweekly schedules have no day of month; the others default to the start date's day.
    const contributionDay = inv.contributionDay ?? inv.contributionStartDate.getUTCDate();

    const schedule = { frequency, contributionDay, startDate: inv.contributionStartDate, endDate: inv.contributionEndDate };
    let due = dueSipPeriods(schedule, asOf);

    // Only a schedule LONGER than the per-run cap needs a cursor: otherwise the cap keeps selecting
    // the OLDEST periods and the newest are never created. Resume after the latest contribution
    // already generated. Ordinary schedules never run this query and fill any gap, as before.
    if (due.length >= maxPeriodsPerRun(frequency)) {
      const latest = await this.prisma.client.investmentCashflow.aggregate({
        where: { investmentId, userId, type: "CONTRIBUTION", origin: "RECURRING" },
        _max: { occurredAt: true },
      });
      due = dueSipPeriods(schedule, asOf, { after: latest._max.occurredAt });
    }
    if (due.length === 0) return result;

    // A manual contribution already recorded in the same PERIOD (periodKey NULL; the same month for
    // a monthly SIP, the same day for a weekly / biweekly one, the same quarter / year otherwise) is
    // a possible duplicate of the generated one: skip that period and let the user decide, rather
    // than double-counting.
    const [keyed, manual, events, changes] = await Promise.all([
      this.prisma.client.investmentCashflow.findMany({
        where: { investmentId, type: "CONTRIBUTION", periodKey: { in: due.map((d) => d.periodKey) } },
        select: { periodKey: true },
      }),
      this.prisma.client.investmentCashflow.findMany({
        where: { investmentId, userId, type: "CONTRIBUTION", periodKey: null, occurredAt: { gte: due[0].occurredAt } },
        select: { occurredAt: true },
      }),
      this.prisma.client.sipInstallmentEvent.findMany({ where: { investmentId, periodKey: { in: due.map((d) => d.periodKey) } }, select: { periodKey: true } }),
      this.prisma.client.investmentSipChange.findMany({ where: { userId, investmentId }, orderBy: { effectiveFrom: "asc" }, select: { effectiveFrom: true, amountPerPeriod: true } }),
    ]);
    const existing = new Set(keyed.map((k) => k.periodKey));
    const manualPeriods = new Set(manual.map((m) => sipPeriodKeyFor(frequency, m.occurredAt)));
    const heldPeriods = new Set(events.map((e) => e.periodKey));

    for (const p of due) {
      if (existing.has(p.periodKey) || manualPeriods.has(p.periodKey)) {
        result.alreadyExisted.push(p.periodKey);
        continue;
      }
      if (heldPeriods.has(p.periodKey)) {
        result.held.push(p.periodKey);
        continue;
      }
      try {
        await this.prisma.client.investmentCashflow.create({
          data: {
            userId,
            investmentId,
            type: "CONTRIBUTION",
            amount: this.amountFor(changes, p.occurredAt, inv.monthlyContribution),
            occurredAt: p.occurredAt,
            periodKey: p.periodKey,
            origin: "RECURRING",
          },
        });
        result.created.push(p.periodKey);
      } catch (err) {
        if (isUniqueViolation(err)) result.alreadyExisted.push(p.periodKey);
        else throw err; // never swallow a real financial write failure
      }
    }
    return result;
  }

  async generateAllDueSipContributions(userId: string, asOf: Date = new Date()): Promise<SipGenerationResult[]> {
    const active = await this.prisma.client.investment.findMany({ where: { userId, sipActive: true }, select: { id: true } });
    const out: SipGenerationResult[] = [];
    for (const { id } of active) out.push(await this.generateSipContributions(userId, id, asOf));
    return out;
  }
}
