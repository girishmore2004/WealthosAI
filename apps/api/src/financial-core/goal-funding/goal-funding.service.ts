import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import type { GoalFundLedgerRowDTO, GoalFundOverviewDTO, GoalFundReallocateResultDTO, GoalFundSummaryDTO, GoalFundUseResultDTO, GoalFundBacking } from "@wealthos/types";
import { PrismaService } from "../../prisma/prisma.service";
import { FinancialFactsService } from "../../common/financial-facts/financial-facts.service";
import { lockKey } from "../../common/utils/advisory-lock.util";
import { emergencyReserveDelta, emergencyTargetFromMonths, toDecimal, toMoneyString, utcDayNumber } from "../../common/financial-facts/financial-formulas";
import { enrichGoal } from "../../goals/goal-planning.util";
import { EmergencyFundService } from "../emergency-fund/emergency-fund.service";
import { buildLedger, LedgerEntryInput } from "../emergency-fund/emergency-fund.util";
import { goalFundRules } from "./goal-fund-rules";
import { buildFundOverview } from "./goal-fund-overview.util";
import { GoalFundEntryDto, ReallocateGoalMoneyDto, UpdateGoalPlanDto, UseGoalMoneyDto } from "./dto/goal-fund.dto";
import {
  ORIGIN_GOAL_CLOSED,
  ORIGIN_OPENING,
  ORIGIN_REALLOCATION,
  goalBalance,
  goalBalances,
  isReducing,
  primaryEmergencyGoalId,
  reserveBalance,
  syncGoalBalance,
} from "./goal-funding.core";

const ZERO = new Prisma.Decimal(0);
type Tx = Prisma.TransactionClient;

type GoalRow = {
  id: string;
  userId: string;
  type: string;
  name: string;
  targetAmount: Prisma.Decimal;
  targetDate: Date;
  currentAmount: Prisma.Decimal;
  monthlyContribution: Prisma.Decimal;
  assumedAnnualReturnPercent: Prisma.Decimal | null;
  deadlineSet: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  investments: { id: string; name: string; currentValue: Prisma.Decimal }[];
};

/** The facts a goal is planned and displayed against — identical for the overview, the detail page and every consumer. */
export interface ResolvedGoalFacts {
  backing: GoalFundBacking;
  cash: Prisma.Decimal;
  targetAmount: Prisma.Decimal;
  targetMode: "AMOUNT" | "MONTHS" | null;
  targetMonths: Prisma.Decimal | null;
  needsExpenseHistory: boolean;
  targetDate: Date;
  hasTargetDate: boolean;
  monthlyContribution: Prisma.Decimal;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * Money → Goals for EVERY goal. Two stores, one behaviour:
 *   - the user's primary emergency goal is backed by the emergency RESERVE ledger (EmergencyFundService —
 *     unchanged semantics, reused as is);
 *   - every other goal is backed by its own GoalEntry ledger.
 * Both use the same six entry types, the same signed effect (emergencyReserveDelta), the same ledger/trend/
 * totals functions and the same plan arithmetic, so there is no second implementation to drift.
 *
 * Money in a goal ledger is EARMARKED cash inside the user's own accounts: it is never income, an expense,
 * or a change in net worth, and it is never counted twice (the balance is stored once, in the ledger;
 * Goal.currentAmount is its materialised copy, rewritten in the same transaction).
 *
 * CONCURRENCY: every write takes the same per-user advisory lock the emergency fund uses, so two
 * simultaneous withdrawals/moves cannot both pass a balance check and overdraw a goal.
 */
@Injectable()
export class GoalFundingService {
  constructor(
    private prisma: PrismaService,
    private facts: FinancialFactsService,
    private emergency: EmergencyFundService,
  ) {}

  // ---------------------------------------------------------------------------------------------
  // Resolution: the facts every goal is measured against
  // ---------------------------------------------------------------------------------------------

  /**
   * Cash balance (from the backing ledger), effective target, deadline and monthly plan for each goal.
   * `goals` must contain ALL of the user's active goals unless `primaryId` is supplied (that is how the
   * primary emergency goal is identified).
   */
  async resolveFacts(
    userId: string,
    goals: Pick<GoalRow, "id" | "type" | "createdAt" | "archivedAt" | "targetAmount" | "targetDate" | "monthlyContribution" | "deadlineSet">[],
    opts: { primaryId?: string | null; avgEssential?: Prisma.Decimal } = {},
  ): Promise<Map<string, ResolvedGoalFacts>> {
    const db = this.prisma.client;
    const primaryId =
      opts.primaryId !== undefined
        ? opts.primaryId
        : [...goals]
            .filter((g) => g.type === "EMERGENCY_FUND" && !g.archivedAt)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))[0]?.id ?? null;

    const ledgerIds = goals.filter((g) => g.id !== primaryId).map((g) => g.id);
    const [balances, reserve, plan] = await Promise.all([
      ledgerIds.length ? goalBalances(db, userId, ledgerIds) : Promise.resolve(new Map<string, Prisma.Decimal>()),
      primaryId ? reserveBalance(db, userId) : Promise.resolve(ZERO),
      primaryId ? db.emergencyFundPlan.findUnique({ where: { userId } }) : Promise.resolve(null),
    ]);
    let avg = opts.avgEssential ?? null;
    if (primaryId && plan?.targetMonths != null && avg === null) {
      avg = toDecimal((await this.facts.getEmergencyCoverage(userId)).avgMonthlyEssentialExpenses);
    }

    const out = new Map<string, ResolvedGoalFacts>();
    for (const g of goals) {
      const goalTarget = toDecimal(g.targetAmount);
      if (g.id !== primaryId) {
        out.set(g.id, {
          backing: "GOAL_LEDGER",
          cash: balances.get(g.id) ?? ZERO,
          targetAmount: goalTarget,
          targetMode: goalTarget.gt(0) ? "AMOUNT" : null,
          targetMonths: null,
          needsExpenseHistory: false,
          targetDate: g.targetDate,
          hasTargetDate: g.deadlineSet,
          monthlyContribution: toDecimal(g.monthlyContribution),
        });
        continue;
      }
      // The emergency plan is authoritative for the target when it has one (it also supports "N months").
      let targetAmount = goalTarget;
      let mode: ResolvedGoalFacts["targetMode"] = goalTarget.gt(0) ? "AMOUNT" : null;
      let months: Prisma.Decimal | null = null;
      let needsHistory = false;
      if (plan?.targetMonths != null) {
        months = toDecimal(plan.targetMonths);
        const t = emergencyTargetFromMonths(months, avg ?? ZERO);
        mode = "MONTHS";
        needsHistory = t === null;
        targetAmount = t ?? ZERO;
      } else if (plan?.targetAmount != null) {
        targetAmount = toDecimal(plan.targetAmount);
        mode = "AMOUNT";
      }
      out.set(g.id, {
        backing: "RESERVE",
        cash: reserve,
        targetAmount,
        targetMode: mode,
        targetMonths: months,
        needsExpenseHistory: needsHistory,
        targetDate: plan?.targetDate ?? g.targetDate,
        hasTargetDate: plan?.targetDate != null ? true : g.deadlineSet,
        monthlyContribution: plan?.monthlyContribution != null ? toDecimal(plan.monthlyContribution) : toDecimal(g.monthlyContribution),
      });
    }
    return out;
  }

  // ---------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------

  async listFunds(userId: string, opts: { includeArchived?: boolean; now?: Date } = {}): Promise<GoalFundSummaryDTO[]> {
    const now = opts.now ?? new Date();
    const db = this.prisma.client;
    const all = await db.goal.findMany({
      where: { userId, ...(opts.includeArchived ? {} : { archivedAt: null }) },
      include: { investments: { select: { id: true, name: true, currentValue: true } } },
    });
    const active = all.filter((g) => !g.archivedAt);
    const [resolved, counts, reserveCount] = await Promise.all([
      this.resolveFacts(userId, active),
      db.goalEntry.groupBy({ by: ["goalId"], where: { userId }, _count: { _all: true } }),
      db.emergencyFundEntry.count({ where: { userId } }),
    ]);
    const countOf = new Map(counts.map((c) => [c.goalId, c._count._all]));

    const rows = all.map((g) => {
      const r =
        resolved.get(g.id) ??
        ({ backing: "GOAL_LEDGER", cash: toDecimal(g.currentAmount), targetAmount: toDecimal(g.targetAmount), targetDate: g.targetDate, hasTargetDate: g.deadlineSet, monthlyContribution: toDecimal(g.monthlyContribution) } as ResolvedGoalFacts);
      const dto = enrichGoal(
        { ...g, currentAmount: r.cash, targetAmount: r.targetAmount, targetDate: r.targetDate, monthlyContribution: r.monthlyContribution, deadlineSet: r.hasTargetDate },
        r.backing,
        now,
      );
      const hasTarget = r.targetAmount.gt(0);
      const summary: GoalFundSummaryDTO = {
        id: g.id,
        name: g.name,
        type: g.type as GoalFundSummaryDTO["type"],
        backing: r.backing,
        archived: !!g.archivedAt,
        cashBalance: dto.currentAmount,
        linkedInvestmentValue: dto.linkedInvestmentValue,
        totalFunded: toMoneyString(r.cash.plus(toDecimal(dto.linkedInvestmentValue))),
        targetAmount: hasTarget ? dto.targetAmount : null,
        shortfall: hasTarget ? dto.shortfall ?? "0.00" : null,
        progressPercent: hasTarget ? dto.progressPercent : null,
        reached: hasTarget && Number(dto.shortfall ?? 0) === 0,
        targetDate: r.hasTargetDate ? dto.targetDate : null,
        monthlyContribution: r.monthlyContribution.gt(0) ? dto.monthlyContribution : null,
        requiredMonthlyContribution: r.hasTargetDate && hasTarget ? dto.requiredMonthlyContribution : null,
        probabilityOfSuccess: dto.probabilityOfSuccess,
        entryCount: r.backing === "RESERVE" ? reserveCount : countOf.get(g.id) ?? 0,
      };
      return { summary, targetDate: g.targetDate.getTime(), primary: r.backing === "RESERVE" };
    });
    // Active before archived; the emergency reserve first (the template everything else follows), then by deadline.
    rows.sort((a, b) => Number(!!a.summary.archived) - Number(!!b.summary.archived) || Number(b.primary) - Number(a.primary) || a.targetDate - b.targetDate);
    return rows.map((r) => r.summary);
  }

  private async loadGoal(db: Pick<Tx, "goal">, userId: string, goalId: string): Promise<GoalRow> {
    const goal = await db.goal.findFirst({
      where: { id: goalId, userId },
      include: { investments: { select: { id: true, name: true, currentValue: true } } },
    });
    if (!goal) throw new NotFoundException("Goal not found");
    return goal as unknown as GoalRow;
  }

  private assertActive(goal: GoalRow) {
    if (goal.archivedAt) throw new BadRequestException("This goal is archived and read-only. Restore it from the Goals page to change it.");
  }

  async overview(userId: string, goalId: string, now: Date = new Date()): Promise<GoalFundOverviewDTO> {
    const db = this.prisma.client;
    const goal = await this.loadGoal(db, userId, goalId);
    const primaryId = goal.archivedAt ? null : await primaryEmergencyGoalId(db, userId);
    const reserve = !goal.archivedAt && goal.id === primaryId;
    const coverage = reserve ? await this.facts.getEmergencyCoverage(userId) : null;

    const resolved = (
      await this.resolveFacts(userId, [goal], { primaryId: reserve ? goal.id : null, avgEssential: coverage ? toDecimal(coverage.avgMonthlyEssentialExpenses) : undefined })
    ).get(goal.id)!;

    const entries: LedgerEntryInput[] = reserve
      ? await db.emergencyFundEntry.findMany({ where: { userId } })
      : await db.goalEntry.findMany({ where: { userId, goalId } });

    const cash = reserve && coverage ? toDecimal(coverage.emergencyCash) : resolved.cash;
    const linked = goal.investments.reduce((s, i) => s.plus(toDecimal(i.currentValue)), ZERO);
    const core = buildFundOverview({
      entries,
      cashBalance: cash,
      linkedInvestmentValue: linked,
      target: {
        mode: resolved.targetMode,
        amount: resolved.targetAmount.gt(0) ? resolved.targetAmount : null,
        months: resolved.targetMonths,
        needsExpenseHistory: resolved.needsExpenseHistory,
      },
      plan: { monthlyContribution: resolved.monthlyContribution.gt(0) ? resolved.monthlyContribution : null, targetDate: resolved.hasTargetDate ? resolved.targetDate : null },
      now,
    });
    const { totalFunded, ...rest } = core;

    const dto = enrichGoal(
      { ...goal, currentAmount: cash, targetAmount: resolved.targetAmount, targetDate: resolved.targetDate, monthlyContribution: resolved.monthlyContribution, deadlineSet: resolved.hasTargetDate },
      resolved.backing,
      now,
    );

    return {
      ...rest,
      goal: { id: goal.id, name: goal.name, type: goal.type as GoalFundOverviewDTO["goal"]["type"], backing: resolved.backing, archived: !!goal.archivedAt, hasTargetDate: resolved.hasTargetDate, createdAt: goal.createdAt.toISOString() },
      rules: goalFundRules(goal.type, resolved.backing),
      coverage: coverage ? { months: coverage.coverageMonths, avgMonthlyEssentialExpenses: coverage.avgMonthlyEssentialExpenses, monthsOfData: coverage.monthsOfData } : null,
      funding: {
        cashBalance: rest.balance,
        linkedInvestmentValue: toMoneyString(linked),
        totalFunded,
        linkedInvestments: goal.investments.map((i) => ({ id: i.id, name: i.name, currentValue: toMoneyString(toDecimal(i.currentValue)) })),
      },
      status: {
        probabilityOfSuccess: dto.probabilityOfSuccess,
        contributionPaceRatio: dto.contributionPaceRatio,
        isPaceHeuristic: true,
        requiredMonthlyWithGrowth: dto.requiredMonthlyContribution,
        assumedAnnualReturnPercent: dto.assumedAnnualReturnPercent,
      },
    };
  }

  async ledger(userId: string, goalId: string): Promise<GoalFundLedgerRowDTO[]> {
    const db = this.prisma.client;
    const goal = await this.loadGoal(db, userId, goalId);
    const primaryId = goal.archivedAt ? null : await primaryEmergencyGoalId(db, userId);
    const entries: LedgerEntryInput[] =
      goal.id === primaryId ? await db.emergencyFundEntry.findMany({ where: { userId } }) : await db.goalEntry.findMany({ where: { userId, goalId } });
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

  // ---------------------------------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------------------------------

  /** A previous submission of the same requestId, from either ledger (checked under the user lock). */
  private async findReplay(tx: Tx, userId: string, requestId?: string) {
    if (!requestId) return null;
    const [g, e] = await Promise.all([
      tx.goalEntry.findFirst({ where: { userId, idempotencyKey: requestId } }),
      tx.emergencyFundEntry.findFirst({ where: { userId, idempotencyKey: requestId } }),
    ]);
    return g ?? e ?? null;
  }

  /** Validated insert of ONE goal-ledger entry inside the caller's locked transaction; rewrites Goal.currentAmount. */
  private async insertGoalEntry(
    tx: Tx,
    userId: string,
    goal: Pick<GoalRow, "id" | "name">,
    e: { type: GoalFundEntryDto["type"]; amount: number; occurredAt: Date; reason?: string; notes?: string; origin?: string; idempotencyKey?: string; transferGroupId?: string },
  ) {
    if (isReducing(e)) {
      const balance = await goalBalance(tx, userId, goal.id);
      const reduction = new Prisma.Decimal(e.amount).abs();
      if (reduction.gt(balance)) {
        throw new BadRequestException(`Cannot take ${toMoneyString(reduction)} out of "${goal.name}"; it holds ${toMoneyString(balance)}.`);
      }
    }
    const row = await tx.goalEntry.create({
      data: {
        userId,
        goalId: goal.id,
        type: e.type,
        amount: e.amount,
        occurredAt: e.occurredAt,
        reason: e.reason,
        notes: e.notes,
        ...(e.origin ? { origin: e.origin } : {}),
        ...(e.idempotencyKey ? { idempotencyKey: e.idempotencyKey } : {}),
        ...(e.transferGroupId ? { transferGroupId: e.transferGroupId } : {}),
      },
    });
    await syncGoalBalance(tx, userId, goal.id);
    return row;
  }

  /** One insert into whichever ledger backs the goal. */
  private insertFor(tx: Tx, userId: string, goal: GoalRow, backing: GoalFundBacking, e: Parameters<GoalFundingService["insertGoalEntry"]>[3]) {
    return backing === "RESERVE" ? this.emergency.insertEntry(tx, userId, e) : this.insertGoalEntry(tx, userId, goal, e);
  }

  private async backingIn(tx: Tx, userId: string, goal: GoalRow): Promise<GoalFundBacking> {
    return goal.id === (await primaryEmergencyGoalId(tx, userId)) ? "RESERVE" : "GOAL_LEDGER";
  }

  private parseDate(value: string): Date {
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw new BadRequestException("Invalid occurredAt date");
    return d;
  }

  async addEntry(userId: string, goalId: string, dto: GoalFundEntryDto) {
    if (dto.type === "ADJUSTMENT") {
      if (dto.amount === 0) throw new BadRequestException("An adjustment cannot be zero");
    } else if (dto.amount <= 0) {
      throw new BadRequestException("amount must be greater than zero");
    }
    const occurredAt = this.parseDate(dto.occurredAt);

    return this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const goal = await this.loadGoal(tx, userId, goalId);
      this.assertActive(goal);
      const replay = await this.findReplay(tx, userId, dto.requestId);
      if (replay) return replay;
      const backing = await this.backingIn(tx, userId, goal);
      return this.insertFor(tx, userId, goal, backing, {
        type: dto.type,
        amount: dto.amount,
        occurredAt,
        reason: dto.reason,
        notes: dto.notes,
        idempotencyKey: dto.requestId,
      });
    });
  }

  /**
   * USE MONEY. Takes money out of the goal (a WITHDRAWAL — never income, never an expense by itself) and,
   * when it was actually spent, records that spending ONCE in the same transaction:
   *   goal  −X
   *   EXPENSE        → an Expense (counts in spending)           e.g. a holiday, school fees
   *   OTHER_OUTFLOW  → a cash outflow that is NOT spending       e.g. a house down payment
   * Without `spend` the money simply returns to cash (still the user's, no longer set aside).
   */
  async useMoney(userId: string, goalId: string, dto: UseGoalMoneyDto): Promise<GoalFundUseResultDTO> {
    const occurredAt = this.parseDate(dto.occurredAt);
    const peek = await this.loadGoal(this.prisma.client, userId, goalId);
    this.assertActive(peek);
    const reservePrimary = (await primaryEmergencyGoalId(this.prisma.client, userId)) === peek.id;
    const rules = goalFundRules(peek.type, reservePrimary ? "RESERVE" : "GOAL_LEDGER");
    if (dto.spend && !rules.spendModes.includes(dto.spend.mode)) {
      throw new BadRequestException(
        rules.spendModes.length === 0
          ? `Money in a ${rules.typeLabel.toLowerCase()} goal cannot be recorded as spent. Return it to cash instead, then spend it through the normal flows.`
          : `This kind of goal cannot record spending as ${dto.spend.mode === "EXPENSE" ? "an expense" : "a non-expense outflow"}.`,
      );
    }

    if (reservePrimary) {
      // The emergency reserve keeps its own, unchanged, atomic implementation.
      const r = await this.emergency.useMoney(
        userId,
        { amount: dto.amount, occurredAt: dto.occurredAt, reason: dto.reason, notes: dto.notes, expense: dto.spend ? { categoryId: dto.spend.categoryId, merchant: dto.spend.merchant } : undefined },
        dto.requestId,
      );
      return {
        entry: { id: r.entry.id, type: "WITHDRAWAL", amount: toMoneyString(toDecimal(r.entry.amount)) },
        expense: r.expense ? { id: r.expense.id, amount: toMoneyString(toDecimal(r.expense.amount)), flowType: "EXPENSE" } : null,
      };
    }

    return this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const goal = await this.loadGoal(tx, userId, goalId);
      this.assertActive(goal);
      if ((await this.backingIn(tx, userId, goal)) === "RESERVE") {
        throw new BadRequestException("This goal changed to the emergency reserve while you were working; reload and try again.");
      }
      const replay = await this.findReplay(tx, userId, dto.requestId);
      if (replay) return { entry: { id: replay.id, type: "WITHDRAWAL", amount: toMoneyString(toDecimal(replay.amount)) }, expense: null, replayed: true };

      if (dto.spend) {
        const category = await tx.category.findUnique({ where: { id: dto.spend.categoryId }, select: { type: true, name: true } });
        if (!category) throw new BadRequestException("Category not found");
        if (category.type === "SAVINGS") {
          throw new BadRequestException(`"${category.name}" is a savings/investment category and cannot be used for an expense.`);
        }
      }

      const entry = await this.insertGoalEntry(tx, userId, goal, { type: "WITHDRAWAL", amount: dto.amount, occurredAt, reason: dto.reason, notes: dto.notes, idempotencyKey: dto.requestId });

      let expense: { id: string; amount: Prisma.Decimal } | null = null;
      if (dto.spend) {
        expense = await tx.expense.create({
          data: {
            userId,
            categoryId: dto.spend.categoryId,
            merchant: dto.spend.merchant ?? dto.reason ?? goal.name,
            amount: dto.amount,
            spentAt: occurredAt,
            paymentMethod: "OTHER",
            notes: `Paid from goal "${goal.name}"`,
            flowType: dto.spend.mode,
            sourceType: "GOAL_FUND_USE",
            sourceId: entry.id,
            sourceReference: "withdrawal",
          },
          select: { id: true, amount: true },
        });
        await tx.goalEntry.update({ where: { id: entry.id }, data: { expenseId: expense.id } });
      }
      return {
        entry: { id: entry.id, type: "WITHDRAWAL" as const, amount: toMoneyString(toDecimal(entry.amount)) },
        expense: expense && dto.spend ? { id: expense.id, amount: toMoneyString(toDecimal(expense.amount)), flowType: dto.spend.mode } : null,
      };
    });
  }

  /**
   * MOVE MONEY between two goals: TRANSFER_OUT on one, TRANSFER_IN on the other, one transaction, one shared
   * group id. Nothing enters or leaves the user's cash, so no income, expense or net-worth change; the two
   * balances change by exactly the same amount in opposite directions.
   */
  async reallocate(userId: string, fromGoalId: string, dto: ReallocateGoalMoneyDto): Promise<GoalFundReallocateResultDTO> {
    if (dto.toGoalId === fromGoalId) throw new BadRequestException("Choose a different goal to move the money to.");
    const occurredAt = this.parseDate(dto.occurredAt);

    return this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const from = await this.loadGoal(tx, userId, fromGoalId);
      const to = await this.loadGoal(tx, userId, dto.toGoalId);
      this.assertActive(from);
      this.assertActive(to);

      if (dto.requestId) {
        const out = await findLeg(tx, userId, dto.requestId);
        if (out?.transferGroupId) {
          const legs = await legsOf(tx, userId, out.transferGroupId);
          const outLeg = legs.find((l) => l.type === "TRANSFER_OUT");
          const inLeg = legs.find((l) => l.type === "TRANSFER_IN");
          if (outLeg && inLeg) {
            return { groupId: out.transferGroupId, from: { goalId: fromGoalId, entryId: outLeg.id }, to: { goalId: dto.toGoalId, entryId: inLeg.id }, replayed: true };
          }
        }
      }

      const groupId = randomUUID();
      const fromBacking = await this.backingIn(tx, userId, from);
      const toBacking = await this.backingIn(tx, userId, to);
      const outLeg = await this.insertFor(tx, userId, from, fromBacking, {
        type: "TRANSFER_OUT",
        amount: dto.amount,
        occurredAt,
        reason: clip(`Moved to ${to.name}`, 100),
        notes: dto.notes,
        origin: ORIGIN_REALLOCATION,
        transferGroupId: groupId,
        idempotencyKey: dto.requestId,
      });
      const inLeg = await this.insertFor(tx, userId, to, toBacking, {
        type: "TRANSFER_IN",
        amount: dto.amount,
        occurredAt,
        reason: clip(`Moved from ${from.name}`, 100),
        notes: dto.notes,
        origin: ORIGIN_REALLOCATION,
        transferGroupId: groupId,
      });
      return { groupId, from: { goalId: fromGoalId, entryId: outLeg.id }, to: { goalId: dto.toGoalId, entryId: inLeg.id } };
    });
  }

  /** Target (an amount; months of expenses only for the emergency reserve) and the contribution plan. */
  async updatePlan(userId: string, goalId: string, dto: UpdateGoalPlanDto, now: Date = new Date()) {
    const peek = await this.loadGoal(this.prisma.client, userId, goalId);
    this.assertActive(peek);
    if ((await primaryEmergencyGoalId(this.prisma.client, userId)) === peek.id) {
      return this.emergency.updatePlan(userId, dto, now);
    }

    if (dto.targetMonths != null) throw new BadRequestException("Only the emergency fund can be set as months of essential expenses. Choose a target amount.");
    if (dto.targetAmount === null) throw new BadRequestException("A goal needs a target amount.");
    const data: Prisma.GoalUncheckedUpdateInput = {};
    if (dto.targetAmount !== undefined) data.targetAmount = dto.targetAmount;
    if (dto.monthlyContribution !== undefined) data.monthlyContribution = dto.monthlyContribution ?? 0;
    if (dto.targetDate !== undefined) {
      if (dto.targetDate === null) data.deadlineSet = false;
      else {
        const d = new Date(dto.targetDate);
        if (Number.isNaN(d.getTime())) throw new BadRequestException("Invalid targetDate");
        if (utcDayNumber(d) < utcDayNumber(now)) throw new BadRequestException("The target date cannot be in the past.");
        data.targetDate = d;
        data.deadlineSet = true;
      }
    }
    if (Object.keys(data).length === 0) throw new BadRequestException("Nothing to change");

    return this.prisma.client.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const goal = await this.loadGoal(tx, userId, goalId);
      this.assertActive(goal);
      if ((await this.backingIn(tx, userId, goal)) === "RESERVE") throw new BadRequestException("Reload and try again.");
      await tx.goal.update({ where: { id: goalId }, data });
      return { goalId };
    });
  }

  /**
   * Deletes an entry — or, for a move between goals, BOTH legs together. Refused when it would leave any
   * affected goal with a negative balance (the same rule as the emergency fund).
   */
  async removeEntry(userId: string, goalId: string, entryId: string): Promise<{ deleted: boolean; keptExpenseId?: string }> {
    const db = this.prisma.client;
    const peek = await this.loadGoal(db, userId, goalId);
    this.assertActive(peek);
    const reserve = (await primaryEmergencyGoalId(db, userId)) === peek.id;

    if (reserve) {
      const e = await db.emergencyFundEntry.findFirst({ where: { id: entryId, userId } });
      if (!e) throw new NotFoundException("Entry not found");
      if (!e.transferGroupId) return this.emergency.remove(userId, entryId);
    }

    return db.$transaction(async (tx) => {
      await lockKey(tx, userId);
      const primaryId = await primaryEmergencyGoalId(tx, userId);

      const own = reserve
        ? await tx.emergencyFundEntry.findFirst({ where: { id: entryId, userId } })
        : await tx.goalEntry.findFirst({ where: { id: entryId, userId, goalId } });
      if (!own) throw new NotFoundException("Entry not found");
      const groupId = (own as { transferGroupId: string | null }).transferGroupId;

      const legs = groupId ? await legsOf(tx, userId, groupId) : [{ ...own, store: reserve ? ("RESERVE" as const) : ("GOAL" as const), goalId: reserve ? primaryId! : goalId }];
      // Effect of removing the legs, per ledger.
      const drop = new Map<string, Prisma.Decimal>();
      for (const l of legs) {
        const key = l.store === "RESERVE" ? "reserve" : l.goalId;
        drop.set(key, (drop.get(key) ?? ZERO).plus(emergencyReserveDelta({ type: l.type, amount: l.amount })));
      }
      for (const [key, effect] of drop) {
        if (effect.lte(0)) continue; // removing money-out can only raise the balance
        const balance = key === "reserve" ? await reserveBalance(tx, userId) : await goalBalance(tx, userId, key);
        const after = balance.minus(effect);
        if (after.lt(0)) {
          const name = key === "reserve" ? "your emergency fund" : `"${(await tx.goal.findUnique({ where: { id: key }, select: { name: true } }))?.name ?? "the goal"}"`;
          throw new BadRequestException(`Deleting this would leave ${name} negative (${toMoneyString(after)}). Remove or correct the later withdrawals first.`);
        }
      }

      let keptExpenseId: string | undefined;
      for (const l of legs) {
        if (l.store === "RESERVE") await tx.emergencyFundEntry.deleteMany({ where: { id: l.id, userId } });
        else {
          if (l.expenseId) keptExpenseId = l.expenseId;
          await tx.goalEntry.deleteMany({ where: { id: l.id, userId } });
        }
      }
      for (const key of drop.keys()) {
        if (key === "reserve") {
          const rid = primaryId;
          if (rid) await tx.goal.update({ where: { id: rid }, data: { currentAmount: await reserveBalance(tx, userId) } });
        } else await syncGoalBalance(tx, userId, key);
      }
      return { deleted: true as const, ...(keptExpenseId ? { keptExpenseId } : {}) };
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Goal lifecycle helpers (called by GoalsService inside ITS locked transaction)
  // ---------------------------------------------------------------------------------------------

  /** A new goal that starts with money already set aside → an OPENING_BALANCE ledger entry (an earmark, not income). */
  async recordOpeningBalance(tx: Tx, userId: string, goal: { id: string; name: string }, amount: number, isReserve: boolean, now: Date = new Date()) {
    if (!(amount > 0)) return;
    const e = { type: "ALLOCATE" as const, amount, occurredAt: now, reason: "Opening balance", origin: ORIGIN_OPENING };
    if (isReserve) await this.emergency.insertEntry(tx, userId, e);
    else await this.insertGoalEntry(tx, userId, goal, e);
  }

  /** Closing a goal: hands every rupee back to uncommitted cash (a GOAL_CLOSED release) and zeroes the goal. */
  async releaseAll(tx: Tx, userId: string, goal: { id: string; name: string }, now: Date = new Date()): Promise<Prisma.Decimal> {
    const balance = await goalBalance(tx, userId, goal.id);
    if (balance.gt(0)) {
      await this.insertGoalEntry(tx, userId, goal, { type: "RELEASE", amount: Number(balance.toFixed(2)), occurredAt: now, reason: "Goal closed", origin: ORIGIN_GOAL_CLOSED });
    }
    return balance;
  }
}

// --- two-ledger helpers for paired moves ---------------------------------------------------------

type Leg = {
  id: string;
  type: GoalFundEntryDto["type"];
  amount: Prisma.Decimal;
  transferGroupId: string | null;
  expenseId?: string | null;
  store: "RESERVE" | "GOAL";
  goalId: string;
};

async function legsOf(tx: Tx, userId: string, groupId: string): Promise<Leg[]> {
  const [g, e, primary] = await Promise.all([
    tx.goalEntry.findMany({ where: { userId, transferGroupId: groupId } }),
    tx.emergencyFundEntry.findMany({ where: { userId, transferGroupId: groupId } }),
    primaryEmergencyGoalId(tx, userId),
  ]);
  return [
    ...g.map((r) => ({ id: r.id, type: r.type, amount: r.amount, transferGroupId: r.transferGroupId, expenseId: r.expenseId, store: "GOAL" as const, goalId: r.goalId })),
    ...e.map((r) => ({ id: r.id, type: r.type, amount: r.amount, transferGroupId: r.transferGroupId, store: "RESERVE" as const, goalId: primary ?? "" })),
  ];
}

async function findLeg(tx: Tx, userId: string, requestId: string) {
  return (
    (await tx.goalEntry.findFirst({ where: { userId, idempotencyKey: requestId } })) ??
    (await tx.emergencyFundEntry.findFirst({ where: { userId, idempotencyKey: requestId } }))
  );
}
