// Transaction-level helpers shared by EmergencyFundService (the reserve ledger) and GoalFundingService
// (the per-goal ledger). No Nest DI: every function takes the open transaction / client it should use,
// so callers keep one atomic unit of work.
//
// THE MAPPING. A user's cash set aside for emergencies lives in EmergencyFundEntry (the cash-model
// reserve: Emergency Cash, coverage, net worth all read it). That ledger belongs to the user's PRIMARY
// emergency goal = their oldest active EMERGENCY_FUND goal. Every other goal's money lives in GoalEntry.
// Goal.currentAmount is the materialised balance of whichever ledger backs the goal, rewritten in the
// same transaction as every ledger change, so any reader of Goal.currentAmount is always right and the
// money is stored exactly once.

import { Prisma } from "@wealthos/db";
import { emergencyReserveDelta, toDecimal } from "../../common/financial-facts/financial-formulas";

export const ORIGIN_OPENING = "OPENING_BALANCE";
export const ORIGIN_REALLOCATION = "REALLOCATION";
export const ORIGIN_GOAL_CLOSED = "GOAL_CLOSED";

type Tx = Prisma.TransactionClient;
const ZERO = new Prisma.Decimal(0);

export async function primaryEmergencyGoalId(db: Pick<Tx, "goal">, userId: string): Promise<string | null> {
  const g = await db.goal.findFirst({
    where: { userId, type: "EMERGENCY_FUND", archivedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  return g?.id ?? null;
}

/** Authoritative reserve balance, from the ledger, by the shared signed-effect formula. */
export async function reserveBalance(db: Pick<Tx, "emergencyFundEntry">, userId: string): Promise<Prisma.Decimal> {
  const rows = await db.emergencyFundEntry.groupBy({ by: ["type"], where: { userId }, _sum: { amount: true } });
  return rows.reduce((acc, r) => acc.plus(emergencyReserveDelta({ type: r.type, amount: toDecimal(r._sum.amount) })), ZERO);
}

/** Balance of each goal's own ledger (goals without entries are absent → zero). */
export async function goalBalances(db: Pick<Tx, "goalEntry">, userId: string, goalIds?: string[]): Promise<Map<string, Prisma.Decimal>> {
  const rows = await db.goalEntry.groupBy({
    by: ["goalId", "type"],
    where: { userId, ...(goalIds ? { goalId: { in: goalIds } } : {}) },
    _sum: { amount: true },
  });
  const out = new Map<string, Prisma.Decimal>();
  for (const r of rows) {
    out.set(r.goalId, (out.get(r.goalId) ?? ZERO).plus(emergencyReserveDelta({ type: r.type, amount: toDecimal(r._sum.amount) })));
  }
  return out;
}

export async function goalBalance(db: Pick<Tx, "goalEntry">, userId: string, goalId: string): Promise<Prisma.Decimal> {
  return (await goalBalances(db, userId, [goalId])).get(goalId) ?? ZERO;
}

/**
 * Makes sure the user has an active primary emergency goal whenever emergency reserve data exists
 * (the invariant the page relies on). Creates "Emergency fund" from the plan if the user has none.
 * Must run inside the user's locked transaction.
 */
export async function ensureEmergencyGoal(tx: Tx, userId: string, now: Date = new Date()): Promise<string> {
  const existing = await primaryEmergencyGoalId(tx, userId);
  if (existing) return existing;
  const plan = await tx.emergencyFundPlan.findUnique({ where: { userId } });
  const created = await tx.goal.create({
    data: {
      userId,
      type: "EMERGENCY_FUND",
      name: "Emergency fund",
      targetAmount: plan?.targetAmount ?? 0,
      targetDate: plan?.targetDate ?? new Date(now.getTime() + 365 * 86_400_000),
      deadlineSet: plan?.targetDate != null,
      monthlyContribution: plan?.monthlyContribution ?? 0,
      currentAmount: 0,
    },
    select: { id: true },
  });
  return created.id;
}

/** After ANY reserve ledger change: ensure the goal exists and set its currentAmount = reserve balance. */
export async function syncReserveGoal(tx: Tx, userId: string, now: Date = new Date()): Promise<string> {
  const goalId = await ensureEmergencyGoal(tx, userId, now);
  const balance = await reserveBalance(tx, userId);
  await tx.goal.update({ where: { id: goalId }, data: { currentAmount: balance } });
  return goalId;
}

/** After ANY goal-ledger change: currentAmount = that ledger's balance. */
export async function syncGoalBalance(tx: Tx, userId: string, goalId: string): Promise<Prisma.Decimal> {
  const balance = await goalBalance(tx, userId, goalId);
  await tx.goal.update({ where: { id: goalId }, data: { currentAmount: balance } });
  return balance;
}

/** The plan's values mirrored onto the goal row so readers that bypass GoalFundingService stay in step. */
export async function mirrorPlanToGoal(
  tx: Tx,
  goalId: string,
  plan: { targetAmount?: Prisma.Decimal.Value | null; targetDate?: Date | null; monthlyContribution?: Prisma.Decimal.Value | null } | null,
  computedTarget?: Prisma.Decimal | null,
  clearedDate = false,
): Promise<void> {
  const data: Prisma.GoalUncheckedUpdateInput = {};
  const target = plan?.targetAmount != null ? new Prisma.Decimal(plan.targetAmount) : computedTarget ?? null;
  if (target) data.targetAmount = target;
  if (plan?.targetDate) {
    data.targetDate = plan.targetDate;
    data.deadlineSet = true;
  } else if (clearedDate) {
    data.deadlineSet = false;
  }
  if (plan?.monthlyContribution != null) data.monthlyContribution = new Prisma.Decimal(plan.monthlyContribution);
  if (Object.keys(data).length > 0) await tx.goal.update({ where: { id: goalId }, data });
}

export const isReducing = (e: { type: string; amount: number | Prisma.Decimal }): boolean =>
  e.type === "RELEASE" || e.type === "WITHDRAWAL" || e.type === "TRANSFER_OUT" || (e.type === "ADJUSTMENT" && new Prisma.Decimal(e.amount).lt(0));
