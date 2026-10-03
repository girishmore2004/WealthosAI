import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { isUniqueViolation } from "../common/utils/prisma-errors.util";
import { RecordPremiumDto } from "./dto/record-premium.dto";
import {
  INSURANCE_PREMIUM_CATEGORY,
  INSURANCE_PREMIUM_SOURCE,
  PremiumFrequency,
  isValidPremiumPeriod,
  premiumPeriodKey,
} from "./insurance-premium.util";

export interface RecordPremiumResult {
  created: boolean; // false = this policy+period already had its premium expense
  expenseId: string;
  period: string;
}

// InsurancePolicy -> premium event -> linked Expense. The linked expense carries
// sourceType/sourceId/sourceReference, and the DB unique index
// (userId, sourceType, sourceId, sourceReference) guarantees one expense per policy per
// period. Because both manual and generated premiums go through recordPremium(), they
// cannot double-count the same premium.
@Injectable()
export class InsurancePremiumService {
  constructor(private prisma: PrismaService) {}

  async recordPremium(userId: string, policyId: string, dto: RecordPremiumDto = {}): Promise<RecordPremiumResult> {
    const policy = await this.prisma.client.insurancePolicy.findFirst({
      where: { id: policyId, userId }, // ownership enforced in the query
      select: { id: true, provider: true, type: true, premiumAmount: true, premiumFrequency: true },
    });
    if (!policy) throw new NotFoundException("Policy not found");

    const paidAt = dto.paidAt ? new Date(dto.paidAt) : new Date();
    if (Number.isNaN(paidAt.getTime())) throw new BadRequestException("Invalid paidAt date");

    const frequency = policy.premiumFrequency as PremiumFrequency;
    const period = dto.period ?? premiumPeriodKey(frequency, paidAt);
    if (!isValidPremiumPeriod(frequency, period)) {
      throw new BadRequestException(`period "${period}" is not valid for a ${frequency} policy`);
    }

    const where = { userId, sourceType: INSURANCE_PREMIUM_SOURCE, sourceId: policy.id, sourceReference: period };
    const existing = await this.prisma.client.expense.findFirst({ where, select: { id: true } });
    if (existing) return { created: false, expenseId: existing.id, period };

    const category = await this.premiumCategory();
    try {
      const expense = await this.prisma.client.expense.create({
        data: {
          userId,
          categoryId: category.id,
          merchant: policy.provider,
          amount: policy.premiumAmount,
          spentAt: paidAt,
          notes: `${policy.type} premium ${period}`,
          sourceType: INSURANCE_PREMIUM_SOURCE,
          sourceId: policy.id,
          sourceReference: period,
        },
        select: { id: true },
      });
      return { created: true, expenseId: expense.id, period };
    } catch (err) {
      if (isUniqueViolation(err)) {
        // A concurrent request recorded it between our check and insert.
        const winner = await this.prisma.client.expense.findFirst({ where, select: { id: true } });
        if (winner) return { created: false, expenseId: winner.id, period };
      }
      throw err; // never swallow a real financial write failure
    }
  }

  async totals(userId: string) {
    const [policies, linked] = await Promise.all([
      this.prisma.client.insurancePolicy.findMany({
        where: { userId },
        select: { id: true, provider: true, type: true, premiumAmount: true, premiumFrequency: true },
      }),
      this.prisma.client.expense.groupBy({
        by: ["sourceId"],
        where: { userId, sourceType: INSURANCE_PREMIUM_SOURCE },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    const paid = new Map(linked.map((l) => [l.sourceId, l]));
    return policies.map((p) => ({
      policyId: p.id,
      provider: p.provider,
      type: p.type,
      premiumAmount: p.premiumAmount.toString(),
      premiumFrequency: p.premiumFrequency,
      premiumsRecorded: paid.get(p.id)?._count._all ?? 0,
      totalPaid: (paid.get(p.id)?._sum.amount ?? 0).toString(),
    }));
  }

  // Seed categories are not guaranteed to include this one, so it is created on first use.
  // Category.name is UNIQUE; a concurrent first-use race simply re-reads the winner.
  private async premiumCategory() {
    const found = await this.prisma.client.category.findUnique({ where: { name: INSURANCE_PREMIUM_CATEGORY } });
    if (found) return found;
    try {
      return await this.prisma.client.category.create({
        data: { name: INSURANCE_PREMIUM_CATEGORY, type: "NEED", isSystem: true },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        const winner = await this.prisma.client.category.findUnique({ where: { name: INSURANCE_PREMIUM_CATEGORY } });
        if (winner) return winner;
      }
      throw err;
    }
  }
}
