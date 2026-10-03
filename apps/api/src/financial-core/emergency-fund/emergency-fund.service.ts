import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { PrismaService } from "../../prisma/prisma.service";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import { emergencyReserveDelta, toDecimal, toMoneyString } from "../../common/financial-facts/financial-formulas";
import { CreateEmergencyEntryDto } from "./dto/create-emergency-entry.dto";

// Emergency Fund is RESERVED CASH, not an expense. This service only records movements
// of money into/out of the reserve; spending released from it is a separate Expense that
// the user logs through the normal expenses flow.
@Injectable()
export class EmergencyFundService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
  ) {}

  async create(userId: string, dto: CreateEmergencyEntryDto) {
    if (dto.type === "ADJUSTMENT") {
      if (dto.amount === 0) throw new BadRequestException("An adjustment cannot be zero");
    } else if (dto.amount <= 0) {
      throw new BadRequestException("amount must be greater than zero");
    }

    const occurredAt = new Date(dto.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw new BadRequestException("Invalid occurredAt date");

    // Money that leaves the reserve must actually be in it. Compared with Decimal, not floats.
    const reducing =
      dto.type === "RELEASE" ||
      dto.type === "WITHDRAWAL" ||
      dto.type === "TRANSFER_OUT" ||
      (dto.type === "ADJUSTMENT" && dto.amount < 0);
    if (reducing) {
      const balance = await this.balance(userId);
      const reduction = new Prisma.Decimal(dto.amount).abs();
      if (reduction.gt(balance)) {
        throw new BadRequestException(
          `Cannot take ${toMoneyString(reduction)} out of the reserve; Emergency Cash is ${toMoneyString(balance)}.`,
        );
      }
    }

    return this.prisma.client.emergencyFundEntry.create({
      data: { userId, type: dto.type, amount: dto.amount, occurredAt, notes: dto.notes },
    });
  }

  list(userId: string) {
    return this.prisma.client.emergencyFundEntry.findMany({ where: { userId }, orderBy: { occurredAt: "desc" } });
  }

  async remove(userId: string, id: string) {
    // Ownership enforced atomically in the write itself (same pattern as Expenses/Income).
    const res = await this.prisma.client.emergencyFundEntry.deleteMany({ where: { id, userId } });
    if (res.count === 0) throw new NotFoundException("Emergency fund entry not found");
    return { deleted: true };
  }

  /** Authoritative reserve balance, derived from the ledger by the shared formula. */
  private async balance(userId: string): Promise<Prisma.Decimal> {
    const rows = await this.prisma.client.emergencyFundEntry.groupBy({
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
}
