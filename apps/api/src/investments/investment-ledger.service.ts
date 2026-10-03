import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { FinancialFactsService } from "../common/financial-facts/financial-facts.service";
import { isUniqueViolation } from "../common/utils/prisma-errors.util";
import { CreateCashflowDto } from "./dto/create-cashflow.dto";
import { CreateValuationDto } from "./dto/create-valuation.dto";
import { SipScheduleDto } from "./dto/sip-schedule.dto";
import {
  InvestmentTypeName,
  dueSipPeriods,
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
      select: { id: true, type: true, purchaseDate: true, monthlyContribution: true, contributionDay: true, contributionStartDate: true, contributionEndDate: true, sipActive: true },
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
    return this.prisma.client.investmentValuation.upsert({
      where: { investmentId_valuedAt: { investmentId, valuedAt } },
      create: { userId, investmentId, value: dto.value, valuedAt, origin: "MANUAL" },
      update: { value: dto.value, origin: "MANUAL" },
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

    return this.prisma.client.investment.update({
      where: { id: investmentId },
      data: {
        monthlyContribution: dto.monthlyContribution,
        contributionDay: dto.contributionDay,
        contributionStartDate: startDate,
        contributionEndDate: endDate,
        sipActive: dto.active,
      },
    });
  }

  // Materializes due contribution rows for ONE investment. Idempotent: the deterministic
  // key is (investmentId, CONTRIBUTION, periodKey); existing keys are skipped up front and a
  // concurrent insert that still collides on the unique index is treated as "already
  // existed". Re-running never creates a second row, and generated rows are plain cashflows —
  // they can never become templates themselves.
  async generateSipContributions(userId: string, investmentId: string, asOf: Date = new Date()): Promise<SipGenerationResult> {
    const inv = await this.owned(userId, investmentId);
    const result: SipGenerationResult = { investmentId, created: [], alreadyExisted: [] };
    if (!inv.sipActive || !inv.monthlyContribution || !inv.contributionDay || !inv.contributionStartDate) return result;

    const due = dueSipPeriods(
      { contributionDay: inv.contributionDay, startDate: inv.contributionStartDate, endDate: inv.contributionEndDate },
      asOf,
    );
    if (due.length === 0) return result;

    // A manual contribution already recorded for the same month (periodKey NULL) is a
    // possible duplicate of the generated one: skip generation for that month and let the
    // user decide, rather than double-counting.
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
    const manualMonths = new Set(manual.map((m) => m.occurredAt.toISOString().slice(0, 7)));

    for (const p of due) {
      if (existing.has(p.periodKey) || manualMonths.has(p.periodKey)) {
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
