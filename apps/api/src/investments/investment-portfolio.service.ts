import { Injectable } from "@nestjs/common";
import type { InvestmentPortfolioDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { CashflowType } from "../common/financial-facts/financial-formulas";
import { buildPortfolio } from "./investment-portfolio.util";

// The canonical, user-scoped investment summary. Every query is filtered by userId; the arithmetic lives
// in buildPortfolio() (pure and unit-tested). The Investments page and the Home dashboard both call this.
@Injectable()
export class InvestmentPortfolioService {
  constructor(private prisma: PrismaService) {}

  async portfolio(userId: string, asOf: Date = new Date()): Promise<InvestmentPortfolioDTO> {
    const [holdings, cashflows, realized] = await Promise.all([
      this.prisma.client.investment.findMany({
        where: { userId },
        select: {
          id: true,
          name: true,
          type: true,
          currentValue: true,
          costBasis: true,
          purchaseDate: true,
          sipActive: true,
          monthlyContribution: true,
          contributionFrequency: true,
          contributionStartDate: true,
          contributionEndDate: true,
          sipCancelledAt: true,
          valuations: { where: { valuedAt: { lte: asOf } }, orderBy: { valuedAt: "desc" }, take: 1, select: { value: true, valuedAt: true } },
        },
      }),
      this.prisma.client.investmentCashflow.findMany({
        where: { userId, occurredAt: { lte: asOf } },
        select: { investmentId: true, type: true, amount: true, occurredAt: true },
      }),
      this.prisma.client.realizedGainEvent.groupBy({
        by: ["investmentId"],
        where: { userId },
        _sum: { costBasisPortion: true, gainAmount: true },
      }),
    ]);

    return buildPortfolio(
      holdings.map((h) => ({ ...h, latestValuation: h.valuations[0] ?? null })),
      cashflows.map((c) => ({ ...c, type: c.type as CashflowType })),
      realized.map((r) => ({ investmentId: r.investmentId, costBasisPortion: r._sum.costBasisPortion ?? 0, gainAmount: r._sum.gainAmount ?? 0 })),
      asOf,
    );
  }
}
