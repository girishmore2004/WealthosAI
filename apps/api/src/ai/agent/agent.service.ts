import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { randomUUID } from "crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { AGENT_CONTEXT_TURNS, AGENT_MAX_ATTACHMENTS, AGENT_MAX_MESSAGE_CHARS } from "./agent.constants";
import { AgentResponse, MemoryCategory } from "./agent.types";
import { AgentApprovalService, toRequirement } from "./approval/agent-approval.service";
import { AgentChatDto } from "./dto/agent.dto";
import { AgentGraphService } from "./graph/agent-graph.service";
import { AgentMemoryService } from "./memory/agent-memory.service";
import { FinancialSnapshotService } from "./memory/financial-snapshot.service";
import { ToolRegistryService } from "./tools/tool-registry.service";
import { sanitizeUntrusted } from "./security/untrusted-content";
import { redactSensitive } from "./security/output-guard";

const FAILURE_TEXT = "I ran into a problem and couldn't finish that. Nothing was changed. Please try again in a moment.";

// The single entry point behind POST /ai/agent/chat. It owns the conversation (create / continue / persist messages) and hands each
// request to the graph. The userId always comes from the authenticated session passed in by the controller.
@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);

  constructor(
    private prisma: PrismaService,
    private graph: AgentGraphService,
    private approvals: AgentApprovalService,
    private memory: AgentMemoryService,
    private snapshots: FinancialSnapshotService,
    private registry: ToolRegistryService,
  ) {}

  async chat(userId: string, dto: AgentChatDto): Promise<AgentResponse> {
    const typed = dto.message.trim();
    if (typed.length === 0 || typed.length > AGENT_MAX_MESSAGE_CHARS) throw new BadRequestException("Message must be between 1 and 2000 characters");
    // Anything that looks like a card number, ID, password or API key is masked BEFORE it is stored, logged, remembered or sent to a model.
    const redacted = redactSensitive(typed);
    const message = redacted.text;
    if (message.length === 0 || message.length > AGENT_MAX_MESSAGE_CHARS) throw new BadRequestException("Message must be between 1 and 2000 characters");
    const attachmentIds = [...new Set((dto.attachments ?? []).map((a) => a.documentId))].slice(0, AGENT_MAX_ATTACHMENTS);

    const conversation = dto.conversationId ? await this.ownedConversation(userId, dto.conversationId) : await this.prisma.client.agentConversation.create({ data: { userId, title: sanitizeUntrusted(message, 60).text.slice(0, 60) || "New conversation" } });

    const history = (await this.prisma.client.agentMessage.findMany({ where: { conversationId: conversation.id, userId }, orderBy: { createdAt: "desc" }, take: AGENT_CONTEXT_TURNS, select: { role: true, content: true } }))
      .reverse()
      .filter((m) => m.role !== "SYSTEM")
      .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: m.content }));
    await this.prisma.client.agentMessage.create({ data: { conversationId: conversation.id, userId, role: "USER", content: message } });

    try {
      const result = await this.graph.run({ userId, conversationId: conversation.id, message, history, attachmentIds });
      const response = redacted.flags.length > 0 ? { ...result.response, warnings: [...result.response.warnings, "I masked sensitive details in your message (such as card numbers, IDs or passwords). Please don't share these in chat."] } : result.response;
      return await this.saveAssistant(userId, conversation.id, response, result.status === "awaiting_approval");
    } catch (err) {
      this.logger.error(`agent run failed: ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
      return this.saveAssistant(userId, conversation.id, failureResponse(conversation.id), false);
    }
  }

  /** Records the user's decision, then resumes the paused graph so it executes (or abandons) exactly what was shown. */
  async decideApproval(userId: string, approvalId: string, decision: "approve" | "reject"): Promise<AgentResponse> {
    const existing = await this.approvals.get(userId, approvalId); // 404 for anyone else's approval
    const row = await this.approvals.decide(userId, approvalId, decision === "approve" ? "APPROVED" : "REJECTED");
    if (!row) throw new ConflictException(existing.status === "PENDING" ? "This approval has expired." : `This approval was already ${existing.status.toLowerCase()}.`);

    let response: Omit<AgentResponse, "messageId">;
    try {
      const resumed = await this.graph.resume(userId, row.threadId, { decision: decision === "approve" ? "approved" : "rejected" });
      response = resumed.response;
    } catch (err) {
      // The checkpoint is gone (retention) or the resume failed: carry out the approved action directly through the same
      // registry (same validation, authorization and idempotency), rather than losing the user's decision.
      this.logger.warn(`resume failed (${(err as Error).name}); falling back to direct execution`);
      response = await this.executeDirect(userId, row);
    }
    await this.prisma.client.agentConversation.updateMany({ where: { id: row.conversationId, userId }, data: { status: "ACTIVE" } });
    return this.saveAssistant(userId, row.conversationId, response, false);
  }

  private async executeDirect(userId: string, row: { id: string; conversationId: string; toolName: string; proposedInput: unknown; idempotencyKey: string; status: string }): Promise<Omit<AgentResponse, "messageId">> {
    const base = failureResponse(row.conversationId);
    if (row.status === "REJECTED") return { ...base, response: "Okay, I haven't made that change.", answerType: "answer", execution: { status: "rejected", toolCalls: [] } };
    const outcome = await this.registry.invoke({ userId, conversationId: row.conversationId, runId: randomUUID() }, row.toolName, row.proposedInput as Record<string, unknown>, { callId: randomUUID(), approval: { approvalId: row.id }, idempotencyKey: row.idempotencyKey });
    if (outcome.status === "ok") await this.approvals.markExecuted(userId, row.id, { text: outcome.text });
    else await this.approvals.markFailed(userId, row.id, outcome.errorCode ?? "failed");
    const fresh = await this.approvals.get(userId, row.id);
    return { ...base, response: outcome.text, answerType: "action_result", intent: "action_request", approvals: [toRequirement(fresh)], execution: { status: outcome.status === "ok" ? "executed" : "failed", toolCalls: [{ tool: outcome.tool, status: outcome.status }] }, confidence: outcome.status === "ok" ? 0.9 : 0.3 };
  }

  // --- reads ---------------------------------------------------------------------------------------------------

  async listConversations(userId: string, take = 30) {
    return this.prisma.client.agentConversation.findMany({ where: { userId }, orderBy: { lastMessageAt: "desc" }, take: Math.min(take, 100) });
  }

  async getMessages(userId: string, conversationId: string, take = 100) {
    await this.ownedConversation(userId, conversationId);
    return this.prisma.client.agentMessage.findMany({ where: { conversationId, userId }, orderBy: { createdAt: "asc" }, take: Math.min(take, 200) });
  }

  async deleteConversation(userId: string, conversationId: string): Promise<void> {
    await this.ownedConversation(userId, conversationId);
    await this.prisma.client.agentConversation.deleteMany({ where: { id: conversationId, userId } });
  }

  listApprovals(userId: string, status?: string) {
    return this.approvals.list(userId, status);
  }

  async listExecutions(userId: string, conversationId?: string, take = 50) {
    return this.prisma.client.agentToolExecution.findMany({ where: { userId, ...(conversationId ? { conversationId } : {}) }, orderBy: { createdAt: "desc" }, take: Math.min(take, 100) });
  }

  listMemories(userId: string, category?: MemoryCategory, includeSuperseded = false) {
    return this.memory.list(userId, { category, includeSuperseded });
  }

  async correctMemory(userId: string, id: string, content?: string, confirm?: boolean): Promise<void> {
    const ok = content ? await this.memory.correct(userId, id, content) : confirm ? await this.memory.confirm(userId, id) : false;
    if (!ok) throw new NotFoundException("Memory not found");
  }

  async deleteMemory(userId: string, id: string): Promise<void> {
    if (!(await this.memory.remove(userId, id))) throw new NotFoundException("Memory not found");
  }

  memoryAudit(userId: string) {
    return this.memory.auditTrail(userId);
  }

  snapshotHistory(userId: string) {
    return this.snapshots.list(userId, 24);
  }

  tools() {
    return this.registry.list();
  }

  // --- internals -----------------------------------------------------------------------------------------------

  private async ownedConversation(userId: string, id: string) {
    const c = await this.prisma.client.agentConversation.findFirst({ where: { id, userId } });
    if (!c) throw new NotFoundException("Conversation not found");
    return c;
  }

  private async saveAssistant(userId: string, conversationId: string, response: Omit<AgentResponse, "messageId">, awaiting: boolean): Promise<AgentResponse> {
    const saved = await this.prisma.client.agentMessage.create({
      data: { conversationId, userId, role: "ASSISTANT", content: response.response, intent: response.intent, answerType: response.answerType, payload: JSON.parse(JSON.stringify({ ...response, response: undefined })) },
    });
    await this.prisma.client.agentConversation.updateMany({ where: { id: conversationId, userId }, data: { lastMessageAt: new Date(), ...(awaiting ? { status: "AWAITING_APPROVAL" } : {}) } });
    return { ...response, conversationId, messageId: saved.id };
  }
}

function failureResponse(conversationId: string): Omit<AgentResponse, "messageId"> {
  return {
    conversationId,
    response: FAILURE_TEXT,
    intent: "clarification",
    answerType: "answer",
    sections: { verifiedFacts: [], documentEvidence: [], historicalMemory: [], calculatedEstimates: [], assumptions: [], recommendations: [] },
    evidence: [],
    calculations: [],
    actionsProposed: [],
    approvals: [],
    execution: { status: "failed", toolCalls: [] },
    followUps: [],
    warnings: [],
    confidence: 0,
    verification: { passed: true, issues: [] },
  };
}
