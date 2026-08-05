import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { GoalsService } from "../../../goals/goals.service";
import { LoansService } from "../../../loans/loans.service";
import { FinanceCalculatorService } from "../calculation/finance-calculator.service";
import { FinancialPlanAgentService } from "../planning/financial-plan-agent.service";
import { TaskAgentService } from "../execution/task-agent.service";
import { PLAN_AT_RISK_DRIFT_FRACTION } from "../coach2.constants";
import { formatINR } from "../../../common/utils/currency.util";

export interface PlanCheckResult {
  planId: string;
  currentValue: number;
  expectedValue: number;
  onTrack: boolean;
  note: string;
  status: "ACTIVE" | "AT_RISK" | "COMPLETED";
  nudgeCreated: boolean;
  createdTaskId: string | null;
}

// --- EXECUTION MONITORING (the Retriever Agent's role, specialized for plans) --------
//
// Resolves a CoachPlan's `targetMetricType` back to a live number by reading the ONE
// relevant money module for that type (Goals for goal_saved_amount, Loans for
// loan_outstanding_principal, the Calculator Agent's retirement wrapper for
// retirement_corpus_gap) — this is the "Retriever Agent" role, scoped specifically to
// plan tracking rather than to per-question intents (that's DataGathererService's
// job). Compares the resolved value against where the plan's own linear trajectory
// (startingValue -> targetValue over startingDate -> targetDate) says it should be by
// now, and drifts the plan to AT_RISK when off by more than
// PLAN_AT_RISK_DRIFT_FRACTION of the total distance. This is the self-reflection loop
// operating over TIME rather than within one turn: plan -> (time passes) -> act (user
// pays down debt / saves) -> verify (this check) -> refine (nudge + task if drifting).
@Injectable()
export class PlanMonitorService {
  private readonly logger = new Logger(PlanMonitorService.name);

  constructor(
    private prisma: PrismaService,
    private goals: GoalsService,
    private loans: LoansService,
    private calculator: FinanceCalculatorService,
    private planAgent: FinancialPlanAgentService,
    private taskAgent: TaskAgentService,
  ) {}

  async checkPlan(userId: string, planId: string, source: "USER_QUERY" | "PROACTIVE_CHECK"): Promise<PlanCheckResult> {
    const plan = await this.prisma.client.coachPlan.findFirstOrThrow({ where: { id: planId, userId } });

    const currentValue = await this.resolveCurrentValue(userId, plan);
    const expectedValue = this.expectedValueNow(
      Number(plan.startingValue),
      Number(plan.targetValue),
      plan.createdAt,
      plan.targetDate,
    );

    const totalDistance = Math.abs(Number(plan.targetValue) - Number(plan.startingValue));
    // For a "reduce to zero" metric (loan payoff), being AHEAD of schedule means a
    // lower current value than expected; for a "grow to target" metric (savings,
    // retirement gap closing), being ahead means a HIGHER current value. Both are
    // captured by comparing progress made vs progress expected, not raw value vs raw
    // value, so the direction of travel doesn't need special-casing per metric type.
    const progressMade = this.signedProgress(Number(plan.startingValue), Number(plan.targetValue), currentValue);
    const progressExpected = this.signedProgress(Number(plan.startingValue), Number(plan.targetValue), expectedValue);
    const drift = progressExpected - progressMade; // positive = behind schedule
    const driftFraction = totalDistance === 0 ? 0 : drift / totalDistance;

    const isComplete = this.isTargetReached(plan.targetMetricType, currentValue, Number(plan.targetValue));
    const onTrack = isComplete || driftFraction <= PLAN_AT_RISK_DRIFT_FRACTION;
    const newStatus: "ACTIVE" | "AT_RISK" | "COMPLETED" = isComplete ? "COMPLETED" : onTrack ? "ACTIVE" : "AT_RISK";

    const note = isComplete
      ? `Target reached — current value ${formatINR(currentValue)} vs target ${formatINR(Number(plan.targetValue))}.`
      : onTrack
        ? `On track: currently ${formatINR(currentValue)}, expected approximately ${formatINR(expectedValue)} at this point in the timeline.`
        : `Behind schedule: currently ${formatINR(currentValue)}, expected approximately ${formatINR(expectedValue)} by now — drifted ${Math.round(driftFraction * 100)}% of the total distance behind plan.`;

    await this.prisma.client.$transaction([
      this.prisma.client.coachProgressSnapshot.create({
        data: { planId, metricValue: currentValue, onTrack, note, source },
      }),
      this.prisma.client.coachPlan.update({
        where: { id: planId },
        data: { currentValue, status: newStatus, lastCheckedAt: new Date() },
      }),
    ]);

    await this.planAgent.advanceStepsIfDue(planId, new Date());

    let nudgeCreated = false;
    let createdTaskId: string | null = null;
    if (newStatus === "AT_RISK") {
      await this.prisma.client.coachNudge.create({
        data: {
          userId,
          planId,
          severity: driftFraction > PLAN_AT_RISK_DRIFT_FRACTION * 2 ? "CRITICAL" : "WARNING",
          message: `Your plan "${plan.title}" is falling behind schedule. ${note}`,
        },
      });
      createdTaskId = await this.taskAgent.createAdHocTask(
        userId,
        `Review "${plan.title}" — falling behind schedule`,
        note,
        null,
      );
      nudgeCreated = true;
    }

    return { planId, currentValue, expectedValue, onTrack, note, status: newStatus, nudgeCreated, createdTaskId };
  }

  private async resolveCurrentValue(userId: string, plan: { targetMetricType: string; linkedGoalId: string | null; linkedLoanId: string | null; currentValue: unknown }): Promise<number> {
    switch (plan.targetMetricType) {
      case "goal_saved_amount": {
        if (!plan.linkedGoalId) return Number(plan.currentValue);
        const goals = await this.goals.list(userId);
        const goal = goals.find((g) => g.id === plan.linkedGoalId);
        return goal ? Number(goal.currentAmount) : Number(plan.currentValue);
      }
      case "loan_outstanding_principal": {
        if (!plan.linkedLoanId) return Number(plan.currentValue);
        const loans = await this.loans.list(userId);
        const loan = loans.find((l) => l.id === plan.linkedLoanId);
        return loan ? Number(loan.outstandingPrincipal) : Number(plan.currentValue);
      }
      case "retirement_corpus_gap": {
        const { corpusGap } = await this.calculator.retirementCorpusGap(userId);
        return corpusGap;
      }
      case "custom_amount":
      default:
        // No live source to re-resolve against — the last value PlanMonitorService (or
        // plan creation) wrote stands until the user or a future feature updates it
        // explicitly. Never silently invented.
        return Number(plan.currentValue);
    }
  }

  private expectedValueNow(startingValue: number, targetValue: number, startDate: Date, targetDate: Date): number {
    const totalMs = targetDate.getTime() - startDate.getTime();
    if (totalMs <= 0) return targetValue;
    const elapsedMs = Math.min(totalMs, Math.max(0, Date.now() - startDate.getTime()));
    const fraction = elapsedMs / totalMs;
    return startingValue + (targetValue - startingValue) * fraction;
  }

  /** Distance covered from startingValue toward targetValue, signed so "progress" is
   * always a positive number moving in the intended direction regardless of whether
   * the metric counts up (savings) or down (loan payoff). */
  private signedProgress(startingValue: number, targetValue: number, currentValue: number): number {
    const direction = targetValue >= startingValue ? 1 : -1;
    return (currentValue - startingValue) * direction;
  }

  private isTargetReached(targetMetricType: string, currentValue: number, targetValue: number): boolean {
    if (targetMetricType === "loan_outstanding_principal") return currentValue <= Math.max(0, targetValue) + 1;
    return currentValue >= targetValue - Math.max(1, targetValue * 0.01);
  }
}
