import { Injectable, BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { PrismaService } from "../prisma/prisma.service";
import { CreateInvestmentDto } from "./dto/create-investment.dto";
import { UpdateInvestmentDto } from "./dto/update-investment.dto";
import { RebalancePortfolioDto } from "./dto/rebalance-portfolio.dto";
import { ListInvestmentsQueryDto } from "./dto/list-investments-query.dto";
import { RecordSaleDto } from "./dto/record-sale.dto";
import { InvestmentSummaryDTO, RebalancePlanDTO, RebalanceActionDTO } from "@wealthos/types";
import { classifyGainCategory, CapitalGainsExcludedTypeError } from "../tax/capital-gains.util";
import { currentFinancialYear } from "../common/utils/financial-year.util";

const TARGET_SUM_TOLERANCE_PERCENT = 0.5;
// Below this rupee threshold a suggested trade is noise (rounding dust), not a real
// action — collapse it to HOLD instead of asking the user to "sell ₹0.03". Also used as
// the threshold for detecting a *newly*-constrained type during redistribution below.
const MIN_ACTIONABLE_TRADE_AMOUNT = 1;

export interface PagedInvestmentsResult {
  items: Awaited<ReturnType<InvestmentsService["list"]>>;
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class InvestmentsService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.client.investment.findMany({
      where: { userId },
      orderBy: { currentValue: "desc" },
    });
  }

  // Opt-in paginated + filterable listing for accounts with a large holding count.
  // Existing GET /investments is left exactly as-is (unbounded array) since the
  // Investments page consumes it directly as an array — same convention as
  // IncomeService.listPaged() / ExpensesService.listPaged().
  async listPaged(userId: string, query: ListInvestmentsQueryDto): Promise<PagedInvestmentsResult> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 25;

    const where: Prisma.InvestmentWhereInput = {
      userId,
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.client.investment.findMany({
        where,
        orderBy: { currentValue: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.client.investment.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async create(userId: string, dto: CreateInvestmentDto) {
    await this.assertGoalOwnership(userId, dto.goalId);
    return this.prisma.client.investment.create({
      data: { ...dto, userId, purchaseDate: new Date(dto.purchaseDate) },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to Income/Expenses: closes the TOCTOU gap between "check
  // ownership" and "perform the write," and collapses a cross-user access attempt and a
  // nonexistent id into the same 404 rather than leaking which case occurred via a
  // 403/404 split.
  async update(userId: string, id: string, dto: UpdateInvestmentDto) {
    if (dto.goalId !== undefined) {
      await this.assertGoalOwnership(userId, dto.goalId);
    }

    const result = await this.prisma.client.investment.updateMany({
      where: { id, userId },
      data: { ...dto, purchaseDate: dto.purchaseDate ? new Date(dto.purchaseDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Investment not found");
    }

    // updateMany() only returns a count; fetch the row to keep returning the updated
    // record, matching the original method's contract.
    return this.prisma.client.investment.findUnique({ where: { id } });
  }

  // Same atomic-ownership approach, and a genuine round-trip reduction: one
  // deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's
  // investments page (api.investments.remove(id)'s response is never read; it always
  // re-fetches the list afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.investment.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Investment not found");
    }

    return { id };
  }

  // SECURITY FIX: CreateInvestmentDto/UpdateInvestmentDto accept an optional `goalId` to
  // link an investment to a savings goal, but nothing previously verified that goal
  // actually belongs to the same user. GoalsService.enrich() sums `currentValue` across
  // every investment linked via goalId with NO owner check on its side either — so
  // without this guard, any user could link their own investment to another user's
  // (guessable cuid) goal id and have their holding's value silently counted toward a
  // stranger's goal progress: a real cross-tenant data-integrity gap, not just a display
  // bug. Mirrors PropertyService's existing assertLoanAndPolicyOwnership() pattern (a
  // read-only ownership check against another feature's table — GoalsService itself is
  // not modified).
  private async assertGoalOwnership(userId: string, goalId: string | null | undefined) {
    if (!goalId) return;
    const goal = await this.prisma.client.goal.findUnique({ where: { id: goalId } });
    if (!goal || goal.userId !== userId) {
      throw new BadRequestException("goalId does not refer to a goal you own");
    }
  }

  // Portfolio-level rollup used by the dashboard and the Investments page.
  // Note: this is a simple current-value-vs-cost-basis gain/loss, not a true XIRR
  // (which needs a full cashflow history per holding — a later refinement). Left
  // arithmetically unchanged from the original implementation — this method is consumed
  // by Dashboard, Reports, Household, Coach, the Simulator, and the Agentic Coach's data
  // gatherer, all of which assume today's exact numeric output.
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
  // CONSTRAINT REDISTRIBUTION (closes the previously-documented gap): when a type is
  // marked no-sell and its raw target calls for a sell, it used to just HOLD at its
  // current value while every OTHER type's action was still computed against the
  // ORIGINAL, unconstrained target — silently violating the algorithm's own invariant
  // that buys/sells should net out against the fixed total portfolio value. This now
  // resolves a genuine constrained allocation: any type locked at its current value
  // shrinks the "remaining pool" available to everyone else, and the remaining types'
  // *effective* targets are renormalized proportionally to their relative target weights
  // against that smaller pool — see resolveConstrainedTargets() below for the algorithm.
  //
  // Every RebalanceActionDTO now carries BOTH targetValue/targetPercent (what the user
  // literally asked for — unchanged meaning) AND effectiveTargetValue/
  // effectiveTargetPercent (what's actually achievable given the constraint — equal to
  // the raw target when nothing is constrained). BUY/SELL amounts are computed against
  // the effective target, not the raw one, so the plan is always internally consistent:
  // sum(buys) - sum(sells) == cashAvailable holds even when one or more types are
  // constrained, which it did not before this fix.
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

    const { fixedTypes, effectiveTargetValueByType } = this.resolveConstrainedTargets(
      allTypes,
      currentByType,
      targetByType,
      totalAfterCash,
      noSellTypes,
    );

    let totalBuy = 0;
    let totalSell = 0;

    const actions: RebalanceActionDTO[] = Array.from(allTypes)
      .map((type) => {
        const currentValue = currentByType.get(type) ?? 0;
        const targetPercent = targetByType.get(type) ?? 0;
        const targetValue = (targetPercent / 100) * totalAfterCash; // "what you asked for" — unchanged
        const effectiveTargetValue = effectiveTargetValueByType.get(type) ?? targetValue;
        const effectiveTargetPercent =
          totalAfterCash > 0 ? Number(((effectiveTargetValue / totalAfterCash) * 100).toFixed(1)) : 0;

        let action: RebalanceActionDTO["action"] = "HOLD";
        let amount = 0;
        const constrained = fixedTypes.has(type);

        if (!constrained) {
          const diff = effectiveTargetValue - currentValue;
          if (diff > MIN_ACTIONABLE_TRADE_AMOUNT) {
            action = "BUY";
            amount = diff;
            totalBuy += amount;
          } else if (diff < -MIN_ACTIONABLE_TRADE_AMOUNT) {
            action = "SELL";
            amount = -diff;
            totalSell += amount;
          }
        }
        // constrained types stay HOLD/amount=0 — locked at current value by request.

        return {
          type: type as RebalanceActionDTO["type"],
          currentValue,
          currentPercent: totalCurrentValue > 0 ? Number(((currentValue / totalCurrentValue) * 100).toFixed(1)) : 0,
          targetPercent,
          targetValue,
          effectiveTargetPercent,
          effectiveTargetValue,
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

  // Iterative fixed-point constraint resolution.
  //
  // A single pass (fix the types that are obviously over-target-and-no-sell against the
  // FULL total, then renormalize everyone else once) is not sufficient in general: once
  // a type is fixed at its current value, the "remaining pool" available to the other
  // types shrinks, which can push a *different* no-sell type's renormalized target below
  // its own current value for the first time — a second-order constraint the first pass
  // couldn't have seen. This loop repeats the renormalization step, adding any newly
  // discovered constrained type to the fixed set, until a pass produces no new
  // constraints (a true fixed point) — see the "cascading constraint" test in this
  // feature's test suite for a concrete example where this matters.
  //
  // Convergence: `fixedTypes` only ever grows and is bounded by allTypes.size (the
  // InvestmentType enum has a handful of values in practice), so this always terminates
  // in at most |allTypes| passes, each O(|allTypes|) — negligible cost.
  private resolveConstrainedTargets(
    allTypes: Set<string>,
    currentByType: Map<string, number>,
    targetByType: Map<string, number>,
    totalAfterCash: number,
    noSellTypes: Set<string>,
  ): { fixedTypes: Set<string>; effectiveTargetValueByType: Map<string, number> } {
    const fixedTypes = new Set<string>();
    let effectiveTargetValueByType = new Map<string, number>();

    for (let pass = 0; pass <= allTypes.size; pass++) {
      const remainingTypes = Array.from(allTypes).filter((t) => !fixedTypes.has(t));
      const fixedValue = Array.from(fixedTypes).reduce((sum, t) => sum + (currentByType.get(t) ?? 0), 0);
      const remainingPool = totalAfterCash - fixedValue;
      const targetWeightSum = remainingTypes.reduce((sum, t) => sum + (targetByType.get(t) ?? 0), 0);

      effectiveTargetValueByType = new Map<string, number>();
      for (const t of fixedTypes) {
        effectiveTargetValueByType.set(t, currentByType.get(t) ?? 0); // locked at current value
      }
      for (const t of remainingTypes) {
        const targetPercent = targetByType.get(t) ?? 0;
        // If every remaining type happens to have 0% target weight (all target weight
        // was assigned to already-constrained types — a genuinely ambiguous input),
        // there's no proportional signal to redistribute by; fall back to holding each
        // remaining type at its current value rather than guessing an arbitrary split.
        const value = targetWeightSum > 0 ? (targetPercent / targetWeightSum) * remainingPool : (currentByType.get(t) ?? 0);
        effectiveTargetValueByType.set(t, value);
      }

      const newlyConstrained = remainingTypes.filter((t) => {
        if (!noSellTypes.has(t)) return false;
        const current = currentByType.get(t) ?? 0;
        const effective = effectiveTargetValueByType.get(t) ?? 0;
        return effective - current < -MIN_ACTIONABLE_TRADE_AMOUNT;
      });

      if (newlyConstrained.length === 0) break;
      for (const t of newlyConstrained) fixedTypes.add(t);
    }

    return { fixedTypes, effectiveTargetValueByType };
  }

  async totalCurrentValue(userId: string): Promise<number> {
    const investments = await this.list(userId);
    return investments.reduce((sum, i) => sum + Number(i.currentValue), 0);
  }

  // NEW (audit item #11): records an explicit sale/disposal of (a portion of) an
  // investment purely for capital-gains tax tracking — deliberately opt-in, never
  // inferred from currentValue changing (see capital-gains.util.ts's doc comment).
  // Does NOT touch the Investment row itself: currentValue/costBasis stay exactly as
  // they are, since this is a tax-tracking side record, not a portfolio edit.
  async recordSale(userId: string, investmentId: string, dto: RecordSaleDto) {
    const investment = await this.prisma.client.investment.findUnique({ where: { id: investmentId } });
    if (!investment || investment.userId !== userId) {
      throw new NotFoundException("Investment not found");
    }

    if (dto.costBasisPortion > Number(investment.costBasis)) {
      throw new BadRequestException("costBasisPortion cannot exceed the investment's total costBasis");
    }

    const saleDate = new Date(dto.saleDate);
    const purchaseDate = new Date(investment.purchaseDate);
    if (saleDate < purchaseDate) {
      throw new BadRequestException("saleDate cannot be before the investment's purchaseDate");
    }

    const holdingPeriodDays = Math.round((saleDate.getTime() - purchaseDate.getTime()) / (1000 * 60 * 60 * 24));

    let gainCategory: string;
    try {
      gainCategory = classifyGainCategory(investment.type, holdingPeriodDays);
    } catch (err) {
      if (err instanceof CapitalGainsExcludedTypeError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }

    const gainAmount = dto.proceeds - dto.costBasisPortion;
    const financialYear = currentFinancialYear(saleDate);

    return this.prisma.client.realizedGainEvent.create({
      data: {
        userId,
        investmentId,
        investmentType: investment.type,
        saleDate,
        proceeds: dto.proceeds,
        costBasisPortion: dto.costBasisPortion,
        gainAmount,
        holdingPeriodDays,
        gainCategory,
        financialYear,
        notes: dto.notes,
      },
    });
  }

  // NEW (audit item #11): every recorded sale/disposal for the caller, most-recent
  // first — optionally filtered to a single financial year.
  listRealizedGains(userId: string, financialYear?: string) {
    return this.prisma.client.realizedGainEvent.findMany({
      where: financialYear ? { userId, financialYear } : { userId },
      orderBy: { saleDate: "desc" },
    });
  }

  // Atomic, ownership-scoped delete — mirrors the same TOCTOU-safe pattern used
  // elsewhere in this service (update()/remove() above).
  async removeRealizedGain(userId: string, id: string) {
    const result = await this.prisma.client.realizedGainEvent.deleteMany({ where: { id, userId } });
    if (result.count === 0) {
      throw new NotFoundException("Realized gain event not found");
    }
    return { id };
  }
}
