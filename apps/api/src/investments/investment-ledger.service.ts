import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { SipScheduleSummaryDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { isUniqueViolation } from "../common/utils/prisma-errors.util";
import { CreateCashflowDto } from "./dto/create-cashflow.dto";
import { CreateValuationDto } from "./dto/create-valuation.dto";
import { SipScheduleDto } from "./dto/sip-schedule.dto";
import { annualContribution, monthlyEquivalent, toDecimal, toMoneyString } from "../common/financial-facts/financial-formulas";
import {
  InvestmentTypeName,
  SipFrequency,
  countSipOccurrences,
  dueSipPeriods,
  maxPeriodsPerRun,
  nextSipOccurrence,
  sipPeriodKeyFor,
  supportsContributionSchedule,
  validateCashflowForType,
} from "./investment-sip.util";

export interface SipGenerationResult {
  investmentId: string;
  created: string[]; // period keys
  alreadyExisted: string[];
}

// Dated cashflows + valuations + SIP schedule for investments. Every method is scoped by
// the authenticated userId and verifies ownership of the investment server-side. All
// derived numbers (net contributions, gains, returns) come from FinancialFactsService —
// profit is never accepted from the client.
@Injectable()
export class InvestmentLedgerService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
  ) {}

  private async owned(userId: string, investmentId: string) {
    const inv = await this.prisma.client.investment.findFirst({
      where: { id: investmentId, userId },
      select: { id: true, type: true, purchaseDate: true, monthlyContribution: true, contributionDay: true, contributionStartDate: true, contributionEndDate: true, sipActive: true, contributionFrequency: true, expectedAnnualReturn: true },
    });
    if (!inv) throw new NotFoundException("Investment not found");
    return inv;
  }

  async addCashflow(userId: string, investmentId: string, dto: CreateCashflowDto) {
    const inv = await this.owned(userId, investmentId);
    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");
    const typeError = validateCashflowForType(inv.type as InvestmentTypeName, dto.type);
    if (typeError) throw new BadRequestException(typeError);

    return this.prisma.client.investmentCashflow.create({
      data: { userId, investmentId, type: dto.type, amount: dto.amount, occurredAt, notes: dto.notes, origin: "MANUAL" },
    });
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

    // MONTHLY is the default, so every existing client (which never sends a frequency) behaves
    // exactly as before. WEEKLY / BIWEEKLY repeat from the start date and have no day of month.
    const frequency: SipFrequency = dto.frequency ?? "MONTHLY";
    const usesDayOfMonth = frequency === "MONTHLY" || frequency === "QUARTERLY" || frequency === "YEARLY";
    const contributionDay = usesDayOfMonth ? (dto.contributionDay ?? startDate.getUTCDate()) : null;

    return this.prisma.client.investment.update({
      where: { id: investmentId },
      data: {
        monthlyContribution: dto.monthlyContribution,
        contributionDay,
        contributionFrequency: frequency,
        contributionStartDate: startDate,
        contributionEndDate: endDate,
        sipActive: dto.active,
        // Only written when supplied: an assumption for projections, never an actual value.
        ...(dto.expectedAnnualReturn !== undefined ? { expectedAnnualReturn: dto.expectedAnnualReturn } : {}),
      },
    });
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

  // Materializes due contribution rows for ONE investment. Idempotent: the deterministic
  // key is (investmentId, CONTRIBUTION, periodKey); existing keys are skipped up front and a
  // concurrent insert that still collides on the unique index is treated as "already
  // existed". Re-running never creates a second row, and generated rows are plain cashflows —
  // they can never become templates themselves.
  async generateSipContributions(userId: string, investmentId: string, asOf: Date = new Date()): Promise<SipGenerationResult> {
    const inv = await this.owned(userId, investmentId);
    const result: SipGenerationResult = { investmentId, created: [], alreadyExisted: [] };
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
    const [keyed, manual] = await Promise.all([
      this.prisma.client.investmentCashflow.findMany({
        where: { investmentId, type: "CONTRIBUTION", periodKey: { in: due.map((d) => d.periodKey) } },
        select: { periodKey: true },
      }),
      this.prisma.client.investmentCashflow.findMany({
        where: { investmentId, userId, type: "CONTRIBUTION", periodKey: null, occurredAt: { gte: due[0].occurredAt } },
        select: { occurredAt: true },
      }),
    ]);
    const existing = new Set(keyed.map((k) => k.periodKey));
    const manualPeriods = new Set(manual.map((m) => sipPeriodKeyFor(frequency, m.occurredAt)));

    for (const p of due) {
      if (existing.has(p.periodKey) || manualPeriods.has(p.periodKey)) {
        result.alreadyExisted.push(p.periodKey);
        continue;
      }
      try {
        await this.prisma.client.investmentCashflow.create({
          data: {
            userId,
            investmentId,
            type: "CONTRIBUTION",
            amount: inv.monthlyContribution,
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
