import "reflect-metadata";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { fakePrisma } from "./fake-prisma";
import { AgentService } from "../../src/ai/agent/agent.service";
import { AgentController } from "../../src/ai/agent/agent.controller";
import { AgentApprovalService } from "../../src/ai/agent/approval/agent-approval.service";
import { PrismaCheckpointSaver } from "../../src/ai/agent/graph/prisma-checkpoint-saver";
import { composeResponse } from "../../src/ai/agent/response/response-composer";
import { SessionAuthGuard } from "../../src/common/guards/session-auth.guard";
import { RateLimitGuard } from "../../src/common/guards/rate-limit.guard";

const response = (text: string) => composeResponse({ conversationId: "c", intent: "financial_analysis", outcomes: [], memories: [], proposed: [], approvals: [], override: { text, answerType: "answer" }, verification: { passed: true, issues: [] }, extraWarnings: [] });

function build(graph: Record<string, unknown>) {
  const db = fakePrisma();
  const approvals = new AgentApprovalService(db as never);
  const registry = { invoke: jest.fn(async () => ({ tool: "create_goal", status: "ok", text: "Goal created." })), list: () => [] };
  const svc = new AgentService(db as never, graph as never, approvals, {} as never, {} as never, registry as never);
  return { db, svc, approvals, registry };
}

describe("AgentService", () => {
  it("creates a conversation, persists both messages and returns the contract", async () => {
    const { svc, db } = build({ run: jest.fn(async () => ({ status: "completed", runId: "r", response: response("hello") })) });
    const r = await svc.chat("u1", { message: "hi there" } as never);
    expect(r.response).toBe("hello");
    expect(r.messageId).toBeTruthy();
    expect(db.table("agentMessage").map((m) => m.role)).toEqual(["USER", "ASSISTANT"]);
    expect(db.table("agentConversation")[0].userId).toBe("u1");
  });
  it("cannot continue or read another user's conversation (404, not 403)", async () => {
    const { svc } = build({ run: jest.fn(async () => ({ status: "completed", runId: "r", response: response("x") })) });
    const first = await svc.chat("u1", { message: "hi there" } as never);
    await expect(svc.chat("u2", { message: "hello", conversationId: first.conversationId } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.getMessages("u2", first.conversationId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.deleteConversation("u2", first.conversationId)).rejects.toBeInstanceOf(NotFoundException);
  });
  it("returns a safe failure response (no stack, nothing changed) when the graph throws", async () => {
    const { svc } = build({ run: jest.fn(async () => { throw new Error("secret stack detail"); }) });
    const r = await svc.chat("u1", { message: "hi there" } as never);
    expect(r.response).not.toContain("secret");
    expect(r.execution.status).toBe("failed");
    expect(r.confidence).toBe(0);
  });
  it("rejects empty or oversized messages and ignores attachments beyond the cap", async () => {
    const run = jest.fn(async () => ({ status: "completed", runId: "r", response: response("x") }));
    const { svc } = build({ run });
    await expect(svc.chat("u1", { message: "   " } as never)).rejects.toThrow();
    await expect(svc.chat("u1", { message: "x".repeat(2001) } as never)).rejects.toThrow();
    await svc.chat("u1", { message: "hello", attachments: Array.from({ length: 9 }, (_, i) => ({ documentId: `d${i}` })) } as never);
    expect((run.mock.calls[0] as unknown as [{ attachmentIds: string[] }])[0].attachmentIds).toHaveLength(5);
  });
  it("approval decision: another user gets 404 and the approval stays pending", async () => {
    const { svc, approvals } = build({ resume: jest.fn() });
    const a = await approvals.createOrReuse({ userId: "u1", conversationId: "c1", threadId: "t1", toolName: "create_goal", risk: "HIGH", summary: "s", input: { name: "x" } });
    await expect(svc.decideApproval("u2", a.id, "approve")).rejects.toBeInstanceOf(NotFoundException);
    expect((await approvals.get("u1", a.id)).status).toBe("PENDING");
  });
  it("approval decision: a second decision conflicts instead of acting twice", async () => {
    const resume = jest.fn(async () => ({ status: "completed", response: response("done") }));
    const { svc, approvals } = build({ resume });
    const a = await approvals.createOrReuse({ userId: "u1", conversationId: "c1", threadId: "t1", toolName: "create_goal", risk: "HIGH", summary: "s", input: { name: "x" } });
    await svc.decideApproval("u1", a.id, "approve");
    await expect(svc.decideApproval("u1", a.id, "approve")).rejects.toBeInstanceOf(ConflictException);
    expect(resume).toHaveBeenCalledTimes(1);
  });
  it("falls back to idempotent direct execution when the checkpoint is gone", async () => {
    const { svc, approvals, registry } = build({ resume: jest.fn(async () => { throw new Error("no checkpoint"); }) });
    const a = await approvals.createOrReuse({ userId: "u1", conversationId: "c1", threadId: "t1", toolName: "create_goal", risk: "HIGH", summary: "s", input: { name: "x" } });
    const r = await svc.decideApproval("u1", a.id, "approve");
    expect(registry.invoke).toHaveBeenCalledTimes(1);
    expect((registry.invoke.mock.calls[0] as unknown as unknown[])[4 - 1]).toMatchObject({ approval: { approvalId: a.id }, idempotencyKey: a.idempotencyKey });
    expect(r.execution.status).toBe("executed");
    expect((await approvals.get("u1", a.id)).status).toBe("EXECUTED");
  });
  it("rejecting via fallback executes nothing", async () => {
    const { svc, approvals, registry } = build({ resume: jest.fn(async () => { throw new Error("no checkpoint"); }) });
    const a = await approvals.createOrReuse({ userId: "u1", conversationId: "c1", threadId: "t1", toolName: "create_goal", risk: "HIGH", summary: "s", input: { name: "x" } });
    const r = await svc.decideApproval("u1", a.id, "reject");
    expect(registry.invoke).not.toHaveBeenCalled();
    expect(r.execution.status).toBe("rejected");
  });
});

describe("AgentController security", () => {
  it("is protected by the session and rate-limit guards", () => {
    const guards = Reflect.getMetadata("__guards__", AgentController) as unknown[];
    expect(guards).toEqual(expect.arrayContaining([SessionAuthGuard, RateLimitGuard]));
    expect(Reflect.getMetadata("path", AgentController)).toBe("ai/agent");
  });
  it("no route accepts a userId from the client", () => {
    const src = require("fs").readFileSync(require.resolve("../../src/ai/agent/agent.controller"), "utf8") as string;
    expect(src).not.toMatch(/@(Body|Query|Param)\(["']userId["']\)/);
    const dto = require("fs").readFileSync(require.resolve("../../src/ai/agent/dto/agent.dto"), "utf8") as string;
    expect(dto).not.toMatch(/userId/);
  });
});

describe("Prisma checkpointer", () => {
  it("scopes checkpoints by user and persists across instances (restart safety)", async () => {
    const db = fakePrisma();
    const a = new PrismaCheckpointSaver(db as never);
    const cfg = (user: string) => ({ configurable: { thread_id: "t1", user_id: user, checkpoint_ns: "" } });
    const cp = { v: 1, id: "00000001", ts: new Date().toISOString(), channel_values: { x: 1 }, channel_versions: {}, versions_seen: {} };
    await a.put(cfg("u1") as never, cp as never, { source: "input", step: 0, parents: {} } as never);
    const b = new PrismaCheckpointSaver(db as never); // a "restarted" process
    expect((await b.getTuple(cfg("u1") as never))?.checkpoint.id).toBe("00000001");
    expect(await b.getTuple(cfg("u2") as never)).toBeUndefined();
  });
});

describe("response composer", () => {
  it("returns the full contract with empty sections by default", () => {
    const r = response("ok");
    expect(Object.keys(r.sections).sort()).toEqual(["assumptions", "calculatedEstimates", "documentEvidence", "historicalMemory", "recommendations", "verifiedFacts"]);
    expect(r).toEqual(expect.objectContaining({ evidence: [], calculations: [], actionsProposed: [], approvals: [], followUps: [], warnings: [] }));
  });
});
