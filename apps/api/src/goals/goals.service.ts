import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { GoalDTO } from "@wealthos/types";
import { PrismaService } from "../prisma/prisma.service";
import { lockKey } from "../common/utils/advisory-lock.util";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { enrichGoal } from "./goal-planning.util";
import { GoalFundingService, ResolvedGoalFacts } from "../financial-core/goal-funding/goal-funding.service";
import { goalBalance, primaryEmergencyGoalId, reserveBalance } from "../financial-core/goal-funding/goal-funding.core";

// GOALS OVERVIEW (planning & tracking). A goal's money is NOT stored here: Goal.currentAmount is the
// materialised balance of the goal's funding ledger (the emergency reserve ledger for the user's primary
// emergency goal, the goal's own GoalEntry ledger for every other goal), and the detailed management —
// add / use / move money, history, target & plan — lives in Money → Goals (GoalFundingService).
// This service owns the goal RECORD (name, type, target, date, plan assumptions) and its lifecycle.
//
// Every write that touches funding runs in one transaction under the same per-user advisory lock the
// funding ledgers use, so a goal can never be edited, closed or retyped while money is moving in or out.
@Injectable()
export class GoalsService {
  constructor(
    private prisma: PrismaService,
    private funding: GoalFundingService,
  ) {}

  async list(userId: string, opts: { includeArchived?: boolean } = {}): Promise<GoalDTO[]> {
    const goals = await this.prisma.client.goal.findMany({
      where: { userId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
      include: { investments: true },
      orderBy: { targetDate: "asc" },
    });
    const resolved = await this.funding.resolveFacts(
      userId,
      goals.filter((g) => !g.archivedAt),
    );
    return goals.map((g) => this.enrich(g, resolved.get(g.id)));
  }

  private async get(userId: string, id: string): Promise<GoalDTO> {
    const goal = await this.prisma.client.goal.findFirst({ where: { id, userId }, include: { investments: true } });
    if (!goal) throw new NotFoundException("Goal not found");
    const primaryId = goal.archivedAt ? null : await primaryEmergencyGoalId(this.prisma.client, userId);
    const resolved = await this.funding.resolveFacts(userId, [goal], { primaryId: goal.id === primaryId ? goal.id : null });
    return this.enrich(goal, resolved.get(goal.id));
  }

  /** The Goals overview figure for one goal, planned against the SAME resolved facts Money → Goals uses. */
  private enrich(
    goal: Parameters<typeof enrichGoal>[0],
    r: ResolvedGoalFacts | undefined,
  ): GoalDTO {
    if (!r) return enrichGoal(goal, "GOAL_LEDGER");
    return enrichGoal(
      { ...goal, currentAmount: r.cash, targetAmount: r.targetAmount, targetDate: r.targetDate, monthlyContribution: r.monthlyContribution, deadlineSet: r.hasTargetDate },
      r.backing,
    );
  }

  async create(userId: string, dto: CreateGoalDto) {
    const { currentAmount, ...rest } = dto;
    const id = await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const isReserve = dto.type === "EMERGENCY_FUND";
      if (isReserve && (await primaryEmergencyGoalId(tx, userId))) {
        throw new BadRequestException("You already have an emergency fund goal. Manage it in Money → Goals; its money is tracked in one place.");
      }
      const goal = await tx.goal.create({
        data: { ...rest, userId, targetDate: new Date(dto.targetDate), deadlineSet: true, currentAmount: 0 },
        select: { id: true, name: true, targetAmount: true, targetDate: true, monthlyContribution: true },
      });
      if (isReserve) await this.writeReservePlan(tx, userId, { targetAmount: goal.targetAmount, targetDate: goal.targetDate, monthlyContribution: goal.monthlyContribution });
      // Money the user says is already set aside becomes a ledger entry, so the balance always has a history.
      if (currentAmount && currentAmount > 0) await this.funding.recordOpeningBalance(tx, userId, goal, currentAmount, isReserve);
      return goal.id;
    });
    return this.get(userId, id);
  }

  /** The emergency plan is authoritative for the reserve's target; saving an amount switches it to an amount target. */
  private async writeReservePlan(
    tx: Prisma.TransactionClient,
    userId: string,
    v: { targetAmount?: Prisma.Decimal.Value; targetDate?: Date; monthlyContribution?: Prisma.Decimal.Value },
  ) {
    const data: Prisma.EmergencyFundPlanUncheckedUpdateInput = {};
    if (v.targetAmount !== undefined) {
      data.targetAmount = v.targetAmount;
      data.targetMonths = null;
    }
    if (v.targetDate !== undefined) data.targetDate = v.targetDate;
    if (v.monthlyContribution !== undefined) data.monthlyContribution = v.monthlyContribution;
    if (Object.keys(data).length === 0) return;
    await tx.emergencyFundPlan.upsert({ where: { userId }, create: { ...(data as Prisma.EmergencyFundPlanUncheckedCreateInput), userId }, update: data });
  }

  private ledgerEntryCount(tx: Prisma.TransactionClient, userId: string, goalId: string, reserve: boolean) {
    return reserve ? tx.emergencyFundEntry.count({ where: { userId } }) : tx.goalEntry.count({ where: { userId, goalId } });
  }

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      // Ownership enforced in the query itself: a foreign id and a missing id are the same 404.
      const goal = await tx.goal.findFirst({ where: { id, userId } });
      if (!goal) throw new NotFoundException("Goal not found");
      if (goal.archivedAt) throw new BadRequestException("This goal is archived. Restore it before changing it.");

      const primaryId = await primaryEmergencyGoalId(tx, userId);
      const reserve = primaryId === id;

      if (dto.currentAmount !== undefined) {
        const cash = reserve ? await reserveBalance(tx, userId) : await goalBalance(tx, userId, id);
        if (!cash.equals(dto.currentAmount)) {
          throw new BadRequestException("The amount saved is the balance of this goal's funding history. Add, use or move money in Money → Goals instead of typing a new number.");
        }
      }

      const data: Prisma.GoalUncheckedUpdateInput = {};
      if (dto.type !== undefined && dto.type !== goal.type) {
        if ((await this.ledgerEntryCount(tx, userId, id, reserve)) > 0) {
          throw new BadRequestException("The type cannot be changed once money has been added to or used from this goal.");
        }
        if (dto.type === "EMERGENCY_FUND" && primaryId) {
          throw new BadRequestException("You already have an emergency fund goal.");
        }
        data.type = dto.type;
      }
      if (dto.name !== undefined) data.name = dto.name;
      if (dto.targetAmount !== undefined) data.targetAmount = dto.targetAmount;
      if (dto.monthlyContribution !== undefined) data.monthlyContribution = dto.monthlyContribution;
      if (dto.assumedAnnualReturnPercent !== undefined) data.assumedAnnualReturnPercent = dto.assumedAnnualReturnPercent;
      if (dto.targetDate !== undefined) {
        data.targetDate = new Date(dto.targetDate);
        data.deadlineSet = true;
      }
      if (Object.keys(data).length > 0) await tx.goal.update({ where: { id }, data });

      // Whichever way it is edited, the emergency goal and the emergency plan describe the same target.
      const becameReserve = data.type === "EMERGENCY_FUND";
      if (reserve || becameReserve) {
        await this.writeReservePlan(tx, userId, {
          targetAmount: dto.targetAmount ?? (becameReserve ? goal.targetAmount : undefined),
          targetDate: dto.targetDate !== undefined ? new Date(dto.targetDate) : becameReserve ? goal.targetDate : undefined,
          monthlyContribution: dto.monthlyContribution ?? (becameReserve ? goal.monthlyContribution : undefined),
        });
      }
    });
    return this.get(userId, id);
  }

  /**
   * Remove a goal.
   *  - never funded            → deleted outright (linked investments are unlinked, as before);
   *  - has funding history     → ARCHIVED: its history is kept, whatever it still holds is released back to
   *                              uncommitted cash (a GOAL_CLOSED entry), linked investments are unlinked
   *                              (they stay in the portfolio), and it leaves every plan and calculation;
   *  - the emergency fund with history cannot be removed (it backs Emergency Cash and coverage): its
   *    entries must be removed first.
   */
  async remove(userId: string, id: string): Promise<{ id: string; archived?: true; releasedAmount?: string; unlinkedInvestments?: number }> {
    return this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const goal = await tx.goal.findFirst({ where: { id, userId } });
      if (!goal) throw new NotFoundException("Goal not found");

      const reserve = (await primaryEmergencyGoalId(tx, userId)) === id;
      const entries = await this.ledgerEntryCount(tx, userId, id, reserve);

      if (entries === 0) {
        await tx.goal.deleteMany({ where: { id, userId } });
        return { id };
      }
      if (reserve) {
        throw new BadRequestException("Your emergency fund has funding history and backs your Emergency Cash and coverage, so it cannot be removed. Delete its entries first if you really want to start over.");
      }
      if (goal.archivedAt) return { id, archived: true as const, releasedAmount: "0.00", unlinkedInvestments: 0 };

      const released = await this.funding.releaseAll(tx, userId, goal);
      const unlinked = await tx.investment.updateMany({ where: { goalId: id, userId }, data: { goalId: null } });
      await tx.goal.update({ where: { id }, data: { archivedAt: new Date(), currentAmount: 0 } });
      return { id, archived: true as const, releasedAmount: released.toFixed(2), unlinkedInvestments: unlinked.count };
    });
  }

  async restore(userId: string, id: string) {
    await this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const goal = await tx.goal.findFirst({ where: { id, userId } });
      if (!goal) throw new NotFoundException("Goal not found");
      if (!goal.archivedAt) throw new BadRequestException("This goal is not archived.");
      if (goal.type === "EMERGENCY_FUND" && (await primaryEmergencyGoalId(tx, userId))) {
        throw new BadRequestException("You already have an emergency fund goal.");
      }
      await tx.goal.update({ where: { id }, data: { archivedAt: null } });
    });
    return this.get(userId, id);
  }
}
