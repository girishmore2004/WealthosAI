import { Injectable, BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateInvestmentDto } from "./dto/create-investment.dto";
import { UpdateInvestmentDto } from "./dto/update-investment.dto";
import { RebalancePortfolioDto } from "./dto/rebalance-portfolio.dto";
import { InvestmentSummaryDTO, RebalancePlanDTO, RebalanceActionDTO } from "@wealthos/types";

const TARGET_SUM_TOLERANCE_PERCENT = 0.5;
// Below this rupee threshold a suggested trade is noise (rounding dust), not a real
// action — collapse it to HOLD instead of asking the user to "sell ₹0.03".
const MIN_ACTIONABLE_TRADE_AMOUNT = 1;

@Injectable()
export class InvestmentsService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.client.investment.findMany({
      where: { userId },
      orderBy: { currentValue: "desc" },
    });
  }

  async create(userId: string, dto: CreateInvestmentDto) {
    return this.prisma.client.investment.create({
      data: { ...dto, userId, purchaseDate: new Date(dto.purchaseDate) },
    });
  }

  async update(userId: string, id: string, dto: UpdateInvestmentDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.investment.update({
      where: { id },
      data: { ...dto, purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.investment.delete({ where: { id } });
  }

  // Portfolio-level rollup used by the dashboard and the Investments page.
  // Note: this is a simple current-value-vs-cost-basis gain/loss, not a true XIRR
  // (which needs a full cashflow history per holding — a later refinement).
  async summary(userId: string): Promise<InvestmentSummaryDTO> {
    const investments = await this.list(userId);

    const totalCurrentValue = investments.reduce((sum, i) => sum + Number(i.currentValue), 0);
    const totalCostBasis = investments.reduce((sum, i) => sum + Number(i.costBasis), 0);
    const totalGainLoss = totalCurrentValue - totalCostBasis;
    const totalGainLossPercent = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

    const byType = new Map<string, number>();
    for (const inv of investments) {
      byType.set(inv.type, (byType.get(inv.type) ?? 0) + Number(inv.currentValue));
    }

    const allocation = Array.from(byType.entries()).map(([type, value]) => ({
      type: type as InvestmentSummaryDTO["allocation"][number]["type"],
      value,
      percent: totalCurrentValue > 0 ? Number(((value / totalCurrentValue) * 100).toFixed(1)) : 0,
    }));

    return {
      totalCurrentValue: totalCurrentValue.toFixed(2),
      totalCostBasis: totalCostBasis.toFixed(2),
      totalGainLoss: totalGainLoss.toFixed(2),
      totalGainLossPercent: Number(totalGainLossPercent.toFixed(2)),
      allocation: allocation.sort((a, b) => b.value - a.value),
    };
  }

  // Portfolio rebalancer: given a target allocation (percent per InvestmentType) and
  // optionally cash the user wants to deploy, suggests buy/sell amounts per type to
  // move the portfolio toward the target.
  //
  // Algorithm (O(n) where n = number of distinct types held or targeted, bounded by
  // the InvestmentType enum — a handful of types in practice):
  //   1. totalAfterCash = current portfolio value + cash being deployed. This is the
  //      new base the target percentages apply against (deploying cash grows the
  //      portfolio, so 100% of the *new* total is what should be allocated).
  //   2. For every type that is either currently held or has a target: targetValue =
  //      targetPercent% of totalAfterCash; diff = targetValue - currentValue.
  //      diff > 0 -> BUY that amount; diff < 0 -> SELL that amount; ~0 -> HOLD.
  //   3. If a type is in `noSellTypes` and its diff is negative, force it to HOLD
  //      instead (the user has said they don't want to sell that holding — e.g. it's
  //      illiquid or has a tax lock-in). That shortfall is NOT redistributed onto
  //      other types in this version — the plan will simply under-shoot the target for
  //      that type and say so via `constrained: true`. Redistributing it correctly
  //      would require a constrained-optimization solver; documented here as a known
  //      simplification rather than silently guessed at.
  //   Invariant when nothing is constrained: sum(buys) - sum(sells) == cashAvailable.
  async rebalance(userId: string, dto: RebalancePortfolioDto): Promise<RebalancePlanDTO> {
    const targetSum = dto.targets.reduce((sum, t) => sum + t.percent, 0);
    if (Math.abs(targetSum - 100) > TARGET_SUM_TOLERANCE_PERCENT) {
      throw new BadRequestException(`Target allocation must sum to 100% (got ${targetSum.toFixed(1)}%).`);
    }

    const investments = await this.list(userId);
    const cashAvailable = dto.cashAvailable ?? 0;
    const noSellTypes = new Set<string>(dto.noSellTypes ?? []);

    const currentByType = new Map<string, number>();
    for (const inv of investments) {
      currentByType.set(inv.type, (currentByType.get(inv.type) ?? 0) + Number(inv.currentValue));
    }

    const totalCurrentValue = Array.from(currentByType.values()).reduce((a, b) => a + b, 0);
    const totalAfterCash = totalCurrentValue + cashAvailable;

    if (totalAfterCash <= 0) {
      throw new BadRequestException(
        "Nothing to rebalance — add investments to your portfolio or provide cash to deploy.",
      );
    }

    const targetByType = new Map(dto.targets.map((t) => [t.type as string, t.percent]));
    const allTypes = new Set<string>([...currentByType.keys(), ...targetByType.keys()]);

    let totalBuy = 0;
    let totalSell = 0;

    const actions: RebalanceActionDTO[] = Array.from(allTypes)
      .map((type) => {
        const currentValue = currentByType.get(type) ?? 0;
        const targetPercent = targetByType.get(type) ?? 0;
        const targetValue = (targetPercent / 100) * totalAfterCash;
        const rawDiff = targetValue - currentValue;

        let action: RebalanceActionDTO["action"] = "HOLD";
        let amount = 0;
        let constrained = false;

        if (rawDiff < 0 && noSellTypes.has(type)) {
          constrained = true;
        } else if (rawDiff > MIN_ACTIONABLE_TRADE_AMOUNT) {
          action = "BUY";
          amount = rawDiff;
          totalBuy += amount;
        } else if (rawDiff < -MIN_ACTIONABLE_TRADE_AMOUNT) {
          action = "SELL";
          amount = -rawDiff;
          totalSell += amount;
        }

        return {
          type: type as RebalanceActionDTO["type"],
          currentValue,
          currentPercent: totalCurrentValue > 0 ? Number(((currentValue / totalCurrentValue) * 100).toFixed(1)) : 0,
          targetPercent,
          targetValue,
          action,
          amount,
          constrained,
        };
      })
      .sort((a, b) => b.currentValue - a.currentValue);

    return {
      totalCurrentValue: totalCurrentValue.toFixed(2),
      cashAvailable: cashAvailable.toFixed(2),
      totalAfterCash: totalAfterCash.toFixed(2),
      actions,
      totalBuy: totalBuy.toFixed(2),
      totalSell: totalSell.toFixed(2),
    };
  }

  async totalCurrentValue(userId: string): Promise<number> {
    const investments = await this.list(userId);
    return investments.reduce((sum, i) => sum + Number(i.currentValue), 0);
  }

  private async assertOwnership(userId: string, investmentId: string) {
    const investment = await this.prisma.client.investment.findUnique({ where: { id: investmentId } });
    if (!investment) throw new NotFoundException("Investment not found");
    if (investment.userId !== userId) throw new ForbiddenException();
  }
}
