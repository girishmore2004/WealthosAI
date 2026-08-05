import { Injectable, NotFoundException } from "@nestjs/common";
import { FinancialPlanAgentService } from "../planning/financial-plan-agent.service";
import { PlanMonitorService } from "./plan-monitor.service";
import { PrismaService } from "../../../prisma/prisma.service";

// Thin facade the controller talks to, so AgenticCoachController doesn't need to know
// about FinancialPlanAgentService vs PlanMonitorService vs raw Prisma reads for
// nudges — one place that owns "what does the Plans/Nudges section of the API
// surface look like".
@Injectable()
export class CoachPlanService {
  constructor(
    private planAgent: FinancialPlanAgentService,
    private monitor: PlanMonitorService,
    private prisma: PrismaService,
  ) {}

  async list(userId: string, status?: "ACTIVE" | "AT_RISK" | "COMPLETED" | "ABANDONED") {
    return this.planAgent.listPlans(userId, status);
  }

  async getOne(userId: string, planId: string) {
    const plan = await this.planAgent.getPlan(userId, planId);
    if (!plan) throw new NotFoundException("Plan not found");
    return plan;
  }

  async refresh(userId: string, planId: string) {
    await this.getOne(userId, planId); // ownership + existence check, throws 404 if not found/owned
    return this.monitor.checkPlan(userId, planId, "USER_QUERY");
  }

  async updateStatus(userId: string, planId: string, status: "COMPLETED" | "ABANDONED") {
    const updated = await this.planAgent.updateStatus(userId, planId, status);
    if (!updated) throw new NotFoundException("Plan not found");
    return { ok: true };
  }

  async listNudges(userId: string) {
    return this.prisma.client.coachNudge.findMany({
      where: { userId, dismissed: false },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
  }

  async dismissNudge(userId: string, nudgeId: string) {
    const result = await this.prisma.client.coachNudge.updateMany({
      where: { id: nudgeId, userId },
      data: { dismissed: true },
    });
    if (result.count === 0) throw new NotFoundException("Nudge not found");
    return { ok: true };
  }
}
