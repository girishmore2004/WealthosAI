import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards, BadRequestException } from "@nestjs/common";
import { User } from "@wealthos/db";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { RateLimit } from "../../common/decorators/rate-limit.decorator";
import { RateLimitGuard } from "../../common/guards/rate-limit.guard";
import { SessionAuthGuard } from "../../common/guards/session-auth.guard";
import { CoachPlanService } from "../coach/plans/coach-plan.service";
import { AgentService } from "./agent.service";
import { AgentChatDto, ApprovalDecisionDto, CorrectMemoryDto } from "./dto/agent.dto";
import { MemoryCategory } from "./agent.types";

const CATEGORIES: MemoryCategory[] = ["EPISODIC", "SEMANTIC", "GOAL", "PROCEDURAL"];
const APPROVAL_STATUSES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "EXECUTED", "FAILED"];

// POST /ai/agent/chat is the one entry point for every AI experience. The existing endpoints (/coach/*, /coach/v2/*, /ai/search,
// /scenario-studio/*, /ml-insights/*) are untouched and keep working. `user.id` comes from the session guard; no route takes a
// user id from the request, and every service call below scopes by it.
@UseGuards(SessionAuthGuard, RateLimitGuard)
@Controller("ai/agent")
export class AgentController {
  constructor(
    private agent: AgentService,
    private plans: CoachPlanService,
  ) {}

  @Post("chat")
  @HttpCode(200)
  @RateLimit(30, 3600)
  chat(@CurrentUser() user: User, @Body() dto: AgentChatDto) {
    return this.agent.chat(user.id, dto);
  }

  // --- conversations -----------------------------------------------------------------------------------------
  @Get("conversations")
  @RateLimit(120, 3600)
  conversations(@CurrentUser() user: User, @Query("take") take?: string) {
    return this.agent.listConversations(user.id, Number(take) || 30);
  }

  @Get("conversations/:id/messages")
  @RateLimit(120, 3600)
  messages(@CurrentUser() user: User, @Param("id") id: string) {
    return this.agent.getMessages(user.id, id);
  }

  @Delete("conversations/:id")
  @HttpCode(204)
  @RateLimit(30, 3600)
  async deleteConversation(@CurrentUser() user: User, @Param("id") id: string) {
    await this.agent.deleteConversation(user.id, id);
  }

  // --- approvals & execution ----------------------------------------------------------------------------------
  @Get("approvals")
  @RateLimit(120, 3600)
  approvals(@CurrentUser() user: User, @Query("status") status?: string) {
    if (status && !APPROVAL_STATUSES.includes(status)) throw new BadRequestException("Unknown status");
    return this.agent.listApprovals(user.id, status);
  }

  @Post("approvals/:id/decision")
  @HttpCode(200)
  @RateLimit(60, 3600)
  decide(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: ApprovalDecisionDto) {
    return this.agent.decideApproval(user.id, id, dto.decision);
  }

  @Get("executions")
  @RateLimit(120, 3600)
  executions(@CurrentUser() user: User, @Query("conversationId") conversationId?: string) {
    return this.agent.listExecutions(user.id, conversationId);
  }

  // --- memory ----------------------------------------------------------------------------------------------------
  @Get("memory")
  @RateLimit(120, 3600)
  memory(@CurrentUser() user: User, @Query("category") category?: string, @Query("includeSuperseded") includeSuperseded?: string) {
    if (category && !CATEGORIES.includes(category as MemoryCategory)) throw new BadRequestException("Unknown category");
    return this.agent.listMemories(user.id, category as MemoryCategory | undefined, includeSuperseded === "true");
  }

  @Patch("memory/:id")
  @HttpCode(204)
  @RateLimit(60, 3600)
  async correctMemory(@CurrentUser() user: User, @Param("id") id: string, @Body() dto: CorrectMemoryDto) {
    if (!dto.content && !dto.confirm) throw new BadRequestException("Provide corrected content or confirm: true");
    await this.agent.correctMemory(user.id, id, dto.content, dto.confirm);
  }

  @Delete("memory/:id")
  @HttpCode(204)
  @RateLimit(60, 3600)
  async deleteMemory(@CurrentUser() user: User, @Param("id") id: string) {
    await this.agent.deleteMemory(user.id, id);
  }

  @Get("memory-audit")
  @RateLimit(60, 3600)
  memoryAudit(@CurrentUser() user: User) {
    return this.agent.memoryAudit(user.id);
  }

  @Get("snapshots")
  @RateLimit(60, 3600)
  snapshots(@CurrentUser() user: User) {
    return this.agent.snapshotHistory(user.id);
  }

  // --- plan progress (existing plan store) -------------------------------------------------------------------------
  @Get("plans")
  @RateLimit(60, 3600)
  listPlans(@CurrentUser() user: User) {
    return this.plans.list(user.id);
  }

  @Get("plans/:id")
  @RateLimit(60, 3600)
  getPlan(@CurrentUser() user: User, @Param("id") id: string) {
    return this.plans.getOne(user.id, id);
  }

  @Get("tools")
  @RateLimit(60, 3600)
  tools() {
    return this.agent.tools();
  }
}
