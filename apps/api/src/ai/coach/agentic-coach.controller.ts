import { Body, Controller, Get, NotFoundException, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { User } from "@wealthos/db";
import { AgenticCoachService } from "./agentic-coach.service";
import { AskV2Dto } from "./dto/ask-v2.dto";
import { CreatePlanDto } from "./dto/create-plan.dto";
import { UpdatePlanStatusDto } from "./dto/update-plan-status.dto";
import { UpdateTaskDto } from "./dto/update-task.dto";
import { CoachPlanService } from "./plans/coach-plan.service";
import { FinancialPlanAgentService } from "./planning/financial-plan-agent.service";
import { TaskAgentService } from "./execution/task-agent.service";

@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("coach/v2")
export class AgenticCoachController {
  constructor(
    private agenticCoach: AgenticCoachService,
    private planService: CoachPlanService,
    private planAgent: FinancialPlanAgentService,
    private taskAgent: TaskAgentService,
  ) {}

  @Post("ask")
  @RateLimit(20, 3600)
  async ask(@CurrentUser() user: User, @Body() dto: AskV2Dto) {
    return this.agenticCoach.ask(user.id, dto.question);
  }

  @Get("history")
  @RateLimit(60, 3600)
  async history(@CurrentUser() user: User, @Query("take") take?: string) {
    const limit = Math.min(Number(take) || 20, 50);
    return this.agenticCoach.history(user.id, limit);
  }

  // --- Plans (Phase 20) ---------------------------------------------------------------
  // Explicit CRUD endpoints alongside the conversational create_plan/plan_progress_check
  // intents above — a "New Plan" button in the UI shouldn't have to phrase a sentence
  // to the chat endpoint just to create a row.

  @Post("plans")
  @RateLimit(20, 3600)
  async createPlan(@CurrentUser() user: User, @Body() dto: CreatePlanDto) {
    const { planId, steps } = await this.planAgent.createPlan({
      userId: user.id,
      type: dto.type,
      title: dto.title,
      objective: dto.objective,
      targetMetricType: dto.targetMetricType,
      targetValue: dto.targetValue,
      targetDate: new Date(dto.targetDate),
      startingValue: dto.startingValue,
      linkedGoalId: dto.linkedGoalId ?? null,
      linkedLoanId: dto.linkedLoanId ?? null,
    });
    const createdTaskIds = await this.taskAgent.createInitialTasksFromPlan(user.id, planId, dto.title, steps, null);
    return { planId, steps, createdTaskIds };
  }

  @Get("plans")
  @RateLimit(60, 3600)
  async listPlans(@CurrentUser() user: User, @Query("status") status?: "ACTIVE" | "AT_RISK" | "COMPLETED" | "ABANDONED") {
    return this.planService.list(user.id, status);
  }

  @Get("plans/:id")
  @RateLimit(60, 3600)
  async getPlan(@CurrentUser() user: User, @Param("id") id: string) {
    return this.planService.getOne(user.id, id);
  }

  @Post("plans/:id/refresh")
  @RateLimit(30, 3600)
  async refreshPlan(@CurrentUser() user: User, @Param("id") id: string) {
    return this.planService.refresh(user.id, id);
  }

  @Patch("plans/:id/status")
  @RateLimit(30, 3600)
  async updatePlanStatus(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdatePlanStatusDto) {
    return this.planService.updateStatus(user.id, id, dto.status);
  }

  // --- Tasks (Phase 20) ----------------------------------------------------------------

  @Get("tasks")
  @RateLimit(60, 3600)
  async listTasks(@CurrentUser() user: User) {
    return this.taskAgent.listOpenTasks(user.id);
  }

  @Patch("tasks/:id")
  @RateLimit(60, 3600)
  async updateTask(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: UpdateTaskDto) {
    const updated = await this.taskAgent.updateStatus(user.id, id, dto.status);
    if (!updated) throw new NotFoundException("Task not found");
    return { ok: true };
  }

  // --- Nudges (Phase 20) ----------------------------------------------------------------

  @Get("nudges")
  @RateLimit(60, 3600)
  async listNudges(@CurrentUser() user: User) {
    return this.planService.listNudges(user.id);
  }

  @Patch("nudges/:id/dismiss")
  @RateLimit(60, 3600)
  async dismissNudge(@CurrentUser() user: User, @Param("id") id: string) {
    return this.planService.dismissNudge(user.id, id);
  }
}
