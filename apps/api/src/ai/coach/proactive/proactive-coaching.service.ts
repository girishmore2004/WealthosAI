import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { PlanMonitorService } from "../plans/plan-monitor.service";

export interface DailyCheckSummary {
  usersScanned: number;
  plansChecked: number;
  nudgesCreated: number;
  errors: number;
}

// --- PROACTIVE COACHING ---------------------------------------------------------------
//
// The background half of "plan -> act -> verify -> refine": instead of only checking a
// plan's progress when the user happens to ask, this runs on a schedule (see
// coach-scheduler.service.ts) and surfaces drift on its own via CoachNudge rows
// (PlanMonitorService already creates these when a plan goes AT_RISK — this service's
// job is purely to iterate every user with an ACTIVE plan and call that same check,
// nothing plan-monitoring-specific lives here twice).
//
// Deliberately simple iteration, not a fan-out job queue per user: at the scale this
// app operates at (a personal-finance coach, not a mass consumer app processing
// millions of plans), a straightforward sequential batch scan that finishes well
// within one BullMQ job's timeout is more debuggable than a queue-of-queues, and it's
// easy to change later if plan counts grow enough to need it — noted here rather than
// silently over-engineered upfront.
@Injectable()
export class ProactiveCoachingService {
  private readonly logger = new Logger(ProactiveCoachingService.name);

  constructor(
    private prisma: PrismaService,
    private monitor: PlanMonitorService,
  ) {}

  async runDailyChecks(): Promise<DailyCheckSummary> {
    const activePlans = await this.prisma.client.coachPlan.findMany({
      where: { status: { in: ["ACTIVE", "AT_RISK"] } },
      select: { id: true, userId: true },
    });

    const userIds = Array.from(new Set(activePlans.map((p) => p.userId)));
    let nudgesCreated = 0;
    let errors = 0;

    for (const plan of activePlans) {
      try {
        const result = await this.monitor.checkPlan(plan.userId, plan.id, "PROACTIVE_CHECK");
        if (result.nudgeCreated) nudgesCreated++;
      } catch (err) {
        errors++;
        this.logger.warn(`Proactive check failed for plan ${plan.id}: ${(err as Error).message}`);
      }
    }

    this.logger.log(
      `Proactive coaching daily scan: ${userIds.length} users, ${activePlans.length} plans, ${nudgesCreated} nudges created, ${errors} errors.`,
    );

    return { usersScanned: userIds.length, plansChecked: activePlans.length, nudgesCreated, errors };
  }
}
