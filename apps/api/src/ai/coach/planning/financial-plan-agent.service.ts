import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { CoachPlanType } from "@wealthos/db";
import { CoachPlanTargetMetric } from "../coach2.constants";

export interface PlanCreationInput {
  userId: string;
  type: CoachPlanType;
  title: string;
  objective: string;
  targetMetricType: CoachPlanTargetMetric;
  targetValue: number;
  targetDate: Date;
  startingValue: number;
  linkedGoalId?: string | null;
  linkedLoanId?: string | null;
}

export interface BuiltStep {
  sequence: number;
  description: string;
  dueDate: Date | null;
}

// --- THE PLANNER AGENT (persistent plans) ---------------------------------------------
//
// Not to be confused with planning/planner.service.ts's PlannerService, which builds a
// short, per-question pipeline plan (which agents to run for THIS turn) and has
// existed since Phase 12 — kept entirely unchanged so the existing per-turn ask() flow
// and its tests are unaffected. This service is new: it builds and maintains
// LONG-RUNNING plans (CoachPlan + CoachPlanStep rows) that persist and get tracked
// across many future sessions, not just the current turn.
//
// A plan's steps are deliberately simple, evenly-spaced milestones derived from the
// timeline and the calculated required pace (handed in by the Calculator Agent via the
// orchestrator) — this is intentionally NOT another LLM call. A monthly cadence with a
// deterministic on-track checkpoint is honest, reviewable, and never hallucinated,
// which matters more here than creatively-worded milestones would.
@Injectable()
export class FinancialPlanAgentService {
  constructor(private prisma: PrismaService) {}

  async createPlan(input: PlanCreationInput): Promise<{ planId: string; steps: BuiltStep[] }> {
    const steps = this.buildSteps(input.startingValue, input.targetValue, input.targetDate);

    const plan = await this.prisma.client.coachPlan.create({
      data: {
        userId: input.userId,
        type: input.type,
        title: input.title,
        objective: input.objective,
        linkedGoalId: input.linkedGoalId ?? null,
        linkedLoanId: input.linkedLoanId ?? null,
        targetMetricType: input.targetMetricType,
        targetValue: input.targetValue,
        targetDate: input.targetDate,
        startingValue: input.startingValue,
        currentValue: input.startingValue,
        status: "ACTIVE",
        steps: {
          create: steps.map((s) => ({
            sequence: s.sequence,
            description: s.description,
            dueDate: s.dueDate ?? undefined,
          })),
        },
      },
      include: { steps: true },
    });

    return { planId: plan.id, steps };
  }

  async getPlan(userId: string, planId: string) {
    return this.prisma.client.coachPlan.findFirst({
      where: { id: planId, userId },
      include: {
        steps: { orderBy: { sequence: "asc" } },
        progress: { orderBy: { checkedAt: "desc" }, take: 10 },
        tasks: { orderBy: { createdAt: "desc" } },
      },
    });
  }

  async listPlans(userId: string, status?: "ACTIVE" | "AT_RISK" | "COMPLETED" | "ABANDONED") {
    return this.prisma.client.coachPlan.findMany({
      where: { userId, status: status ?? undefined },
      include: { steps: { orderBy: { sequence: "asc" } } },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateStatus(userId: string, planId: string, status: "COMPLETED" | "ABANDONED") {
    const result = await this.prisma.client.coachPlan.updateMany({
      where: { id: planId, userId },
      data: { status },
    });
    return result.count > 0;
  }

  /** Marks the next PENDING/IN_PROGRESS step DONE if its milestone date has passed and
   * the plan is still on track as of the latest progress check — called by
   * PlanMonitorService after each check, never directly by the orchestrator. Purely
   * bookkeeping: it never changes CoachPlan.status itself (that stays
   * PlanMonitorService's call, since it needs the actual metric comparison). */
  async advanceStepsIfDue(planId: string, asOf: Date): Promise<void> {
    await this.prisma.client.coachPlanStep.updateMany({
      where: {
        planId,
        status: { in: ["PENDING", "IN_PROGRESS"] },
        dueDate: { lte: asOf },
      },
      data: { status: "DONE", completedAt: asOf },
    });
  }

  /** Evenly-spaced monthly checkpoints between now and the target date, each labeled
   * with the fraction of the distance it expects to be covered by — a plain, honest
   * "you should be roughly X% of the way there by this date" milestone rather than a
   * creatively-worded one. Caps at 12 steps (one per month for up to a year; longer
   * horizons get quarterly steps instead) so a 5-year retirement plan doesn't produce
   * 60 rows. */
  private buildSteps(startingValue: number, targetValue: number, targetDate: Date): BuiltStep[] {
    const now = new Date();
    const totalMonths = Math.max(1, this.monthsBetween(now, targetDate));
    const stepCount = Math.min(12, totalMonths);
    const monthsPerStep = totalMonths / stepCount;
    const totalDistance = targetValue - startingValue;

    const steps: BuiltStep[] = [];
    for (let i = 1; i <= stepCount; i++) {
      const monthsElapsed = Math.round(monthsPerStep * i);
      const dueDate = new Date(now);
      dueDate.setMonth(dueDate.getMonth() + monthsElapsed);
      const expectedFraction = i / stepCount;
      const expectedValue = startingValue + totalDistance * expectedFraction;

      steps.push({
        sequence: i,
        description:
          i === stepCount
            ? `Final checkpoint (${dueDate.toISOString().slice(0, 10)}): should be at target — approximately ${expectedValue.toFixed(2)}.`
            : `Checkpoint ${i} of ${stepCount} (${dueDate.toISOString().slice(0, 10)}): expect to be at approximately ${expectedValue.toFixed(2)} (${Math.round(expectedFraction * 100)}% of the way there).`,
        dueDate,
      });
    }
    return steps;
  }

  private monthsBetween(from: Date, to: Date): number {
    const months = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    return Math.max(1, months);
  }
}
