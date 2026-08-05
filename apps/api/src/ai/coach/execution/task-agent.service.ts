import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";

export interface TaskCreationInput {
  userId: string;
  title: string;
  detail: string;
  dueDate?: Date | null;
  planId?: string | null;
  sourceRunId?: string | null;
}

// --- THE EXECUTION / TASK AGENT --------------------------------------------------------
//
// Turns advice into something the user can actually act on and check off, rather than
// prose that's read once and forgotten. Deliberately dumb/deterministic: this agent
// never decides WHAT to recommend (that's the Planner/Composer's job) — it only takes
// an already-decided piece of advice or plan step and writes it down as a trackable
// CoachTask. No LLM calls here at all.
@Injectable()
export class TaskAgentService {
  constructor(private prisma: PrismaService) {}

  /** Same-day dedupe by (userId, planId, title) — re-running the orchestrator for the
   * same plan on the same day (e.g. a user re-asking "how's my plan going" twice)
   * must not spam duplicate tasks. */
  async createTask(input: TaskCreationInput): Promise<string> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const existing = await this.prisma.client.coachTask.findFirst({
      where: {
        userId: input.userId,
        planId: input.planId ?? null,
        title: input.title,
        status: "OPEN",
        createdAt: { gte: startOfDay },
      },
    });
    if (existing) return existing.id;

    const created = await this.prisma.client.coachTask.create({
      data: {
        userId: input.userId,
        planId: input.planId ?? null,
        title: input.title,
        detail: input.detail,
        dueDate: input.dueDate ?? null,
        sourceRunId: input.sourceRunId ?? null,
        status: "OPEN",
      },
    });
    return created.id;
  }

  /** Turns a freshly-created plan's first two steps into concrete initial tasks —
   * called right after FinancialPlanAgentService.createPlan. Deliberately only the
   * first two: the rest of the plan's steps become tasks progressively (via
   * createTaskFromDueStep, called by PlanMonitorService as each step becomes due),
   * so the user's task list isn't front-loaded with a year's worth of checkpoints on
   * day one. */
  async createInitialTasksFromPlan(
    userId: string,
    planId: string,
    planTitle: string,
    steps: { sequence: number; description: string; dueDate: Date | null }[],
    sourceRunId: string | null,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (const step of steps.slice(0, 2)) {
      const id = await this.createTask({
        userId,
        planId,
        title: `${planTitle} — checkpoint ${step.sequence}`,
        detail: step.description,
        dueDate: step.dueDate,
        sourceRunId,
      });
      ids.push(id);
    }
    return ids;
  }

  async createTaskFromDueStep(
    userId: string,
    planId: string,
    planTitle: string,
    step: { sequence: number; description: string; dueDate: Date | null },
  ): Promise<string> {
    return this.createTask({
      userId,
      planId,
      title: `${planTitle} — checkpoint ${step.sequence}`,
      detail: step.description,
      dueDate: step.dueDate,
      sourceRunId: null,
    });
  }

  /** A one-off task not tied to any long-running plan — e.g. "review your insurance
   * gap" surfacing from a prioritize_actions or risk_tradeoff answer. */
  async createAdHocTask(userId: string, title: string, detail: string, sourceRunId: string | null): Promise<string> {
    return this.createTask({ userId, title, detail, sourceRunId, planId: null });
  }

  async listOpenTasks(userId: string) {
    return this.prisma.client.coachTask.findMany({
      where: { userId, status: "OPEN" },
      orderBy: [{ dueDate: "asc" }, { createdAt: "desc" }],
    });
  }

  async updateStatus(userId: string, taskId: string, status: "DONE" | "DISMISSED"): Promise<boolean> {
    const result = await this.prisma.client.coachTask.updateMany({
      where: { id: taskId, userId },
      data: { status, completedAt: status === "DONE" ? new Date() : undefined },
    });
    return result.count > 0;
  }
}
