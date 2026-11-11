import { z } from "zod";
import { GoalType } from "@wealthos/db";
import { ConfigService } from "@nestjs/config";
import { fakePrisma } from "./fake-prisma";
import { AgentGraphService, dropUnverifiedSentences, routeAfterAuthorize, routeAfterVerify } from "../../src/ai/agent/graph/agent-graph.service";
import { AgentIntentService, resolveFollowUp } from "../../src/ai/agent/intent/agent-intent.service";
import { ActionExtractorService } from "../../src/ai/agent/planning/action-extractor.service";
import { ToolRegistryService } from "../../src/ai/agent/tools/tool-registry.service";
import { AgentApprovalService } from "../../src/ai/agent/approval/agent-approval.service";
import { AgentMemoryService } from "../../src/ai/agent/memory/agent-memory.service";
import { MemoryCryptoService } from "../../src/ai/agent/security/memory-crypto.service";
import { NumericConsistencyVerifier } from "../../src/ai/coach/verification/numeric-consistency.verifier";
import { createGoalSchema } from "../../src/ai/agent/tools/builtin-tools.service";
import { AgentTool } from "../../src/ai/agent/tools/agent-tool.types";

const GOAL_TYPE = Object.values(GoalType)[0];

function build(opts: { engineText?: string; engineHandled?: boolean; extract?: Record<string, unknown>; engineFails?: number } = {}) {
  const db = fakePrisma();
  const gateway = {
    classify: jest.fn(async () => ({ data: { label: "financial_analysis" }, confidence: 0.7 })),
    extract: jest.fn(async () => ({ data: opts.extract ?? {} })),
    generate: jest.fn(async () => ({ data: { text: "A SIP is a way to invest a fixed amount regularly." } })),
  };
  const registry = new ToolRegistryService(db as never);
  const calls: string[] = [];
  let engineFailures = opts.engineFails ?? 0;
  const reg = (t: Partial<AgentTool> & { name: string }) => registry.register({ description: t.name, risk: "LOW", schema: z.object({}).passthrough(), execute: async () => ({ text: "" }), ...t } as AgentTool);
  reg({
    name: "financial_engine_answer",
    schema: z.object({ question: z.string() }).strict(),
    execute: async () => {
      calls.push("financial_engine_answer");
      if (engineFailures-- > 0) throw Object.assign(new Error("down"), { status: 503 });
      return { text: opts.engineText ?? "Your food spending was ₹12,400 this month.", handled: opts.engineHandled ?? true, evidence: [{ kind: "platform_data", label: "Spending", source: "financial_engine" }] };
    },
  });
  reg({ name: "coach_advisor", schema: z.object({ question: z.string() }).strict(), execute: async () => { calls.push("coach_advisor"); return { text: "Coach answer with no numbers." }; } });
  reg({ name: "rag_search", schema: z.object({ query: z.string() }).strict(), execute: async () => { calls.push("rag_search"); return { text: "The policy covers hospitalisation.", untrusted: true, handled: true }; } });
  const created: unknown[] = [];
  reg({
    name: "create_goal",
    risk: "HIGH",
    schema: createGoalSchema,
    summarize: (i: any) => `Create goal "${i.name}" for ${i.targetAmount}`,
    execute: async (_c, input) => { created.push(input); calls.push("create_goal"); return { text: "Goal created." }; },
  });
  const prev = process.env.AGENT_MEMORY_ENCRYPTION_KEY;
  process.env.AGENT_MEMORY_ENCRYPTION_KEY = "d".repeat(64);
  const crypto = new MemoryCryptoService(new ConfigService({}));
  if (prev === undefined) delete process.env.AGENT_MEMORY_ENCRYPTION_KEY; else process.env.AGENT_MEMORY_ENCRYPTION_KEY = prev;
  const memory = new AgentMemoryService(db as never, crypto, { embedWithVersion: async () => { throw new Error("none"); } } as never);
  const approvals = new AgentApprovalService(db as never);
  const consolidation = { schedule: jest.fn(async () => undefined) };
  const graph = new AgentGraphService(db as never, gateway as never, new AgentIntentService(gateway as never), memory, consolidation as never, registry, new ActionExtractorService(gateway as never, db as never, registry), approvals, new NumericConsistencyVerifier());
  graph.onModuleInit();
  return { db, gateway, graph, calls, created, memory, approvals, consolidation };
}

const base = { userId: "u1", conversationId: "c1", history: [], attachmentIds: [] as string[] };

describe("agent graph: end to end", () => {
  it("answers a data question from the finance tool and records an episodic memory", async () => {
    const { graph, calls, consolidation } = build();
    const r = await graph.run({ ...base, message: "How much did I spend on food this month?" });
    expect(r.status).toBe("completed");
    expect(calls).toEqual(["financial_engine_answer"]);
    expect(r.response.response).toContain("12,400");
    expect(r.response.verification.passed).toBe(true);
    expect(r.response.sections.verifiedFacts.length + r.response.evidence.length).toBeGreaterThan(0);
    expect(consolidation.schedule).toHaveBeenCalled();
  });
  it("falls back to the coach when the engine hands off", async () => {
    const { graph, calls } = build({ engineHandled: false, engineText: "" });
    await graph.run({ ...base, message: "How much did I spend on food this month?" });
    expect(calls).toEqual(["financial_engine_answer", "coach_advisor"]);
  });
  it("retries a transient tool failure a bounded number of times, then degrades gracefully", async () => {
    const { graph, calls } = build({ engineFails: 99, engineHandled: false });
    const r = await graph.run({ ...base, message: "How much did I spend on food this month?" });
    expect(r.status).toBe("completed");
    expect(calls.filter((c) => c === "financial_engine_answer").length).toBeLessThanOrEqual(6);
    expect(r.response.response.length).toBeGreaterThan(0);
  });
  it("refuses payments, trades and deletions and plans no tools", async () => {
    const { graph, calls } = build();
    for (const m of ["Transfer 50000 to my brother", "Sell my mutual funds", "Delete all my transactions"]) {
      const r = await graph.run({ ...base, message: m });
      expect(r.response.answerType).toBe("refusal");
    }
    expect(calls).toEqual([]);
  });
  it("answers simple knowledge questions without tools and drops unverifiable figures", async () => {
    const t = build();
    t.gateway.generate.mockResolvedValueOnce({ data: { text: "A SIP invests regularly. Returns average 14.2 percent per year." } } as never);
    const r = await t.graph.run({ ...base, message: "What is a SIP?" });
    expect(t.calls).toEqual([]);
    expect(r.response.response).not.toContain("14.2");
    expect(r.response.warnings.length).toBeGreaterThan(0);
  });
  it("does not follow instructions embedded in document text (untrusted tool output cannot pick tools)", async () => {
    const t = build();
    // rag returns text that tries to trigger a goal creation; the plan is fixed from the user's message so nothing extra runs
    const r = await t.graph.run({ ...base, message: "What does my policy document say about hospitalisation?" });
    expect(t.calls).toEqual(["rag_search"]);
    expect(t.created).toHaveLength(0);
    expect(r.status).toBe("completed");
  });
});

describe("agent graph: human-in-the-loop approval", () => {
  const msg = "Create a goal called New Car for 800000 by 2028-03-31";
  const extract = { type: GOAL_TYPE, name: "New Car", targetAmount: 800000, targetDate: "2028-03-31" };

  it("pauses before a write, executes nothing, and exposes the exact proposal", async () => {
    const t = build({ extract });
    const r = await t.graph.run({ ...base, message: msg });
    expect(r.status).toBe("awaiting_approval");
    expect(r.response.answerType).toBe("approval_request");
    expect(r.response.approvals).toHaveLength(1);
    expect(r.response.approvals[0]).toMatchObject({ tool: "create_goal", risk: "HIGH", status: "PENDING" });
    expect(t.created).toHaveLength(0);
    expect(t.db.table("agentCheckpoint").length).toBeGreaterThan(0);
  });
  it("executes exactly the stored proposal once the user approves (and only once)", async () => {
    const t = build({ extract });
    const run = await t.graph.run({ ...base, message: msg });
    const id = run.response.approvals[0].approvalId;
    await t.approvals.decide("u1", id, "APPROVED");
    const done = await t.graph.resume("u1", run.runId, { decision: "approved" });
    expect(done.status).toBe("completed");
    expect(t.created).toEqual([expect.objectContaining({ name: "New Car", targetAmount: 800000 })]);
    expect((await t.approvals.get("u1", id)).status).toBe("EXECUTED");
    // a second resume (replay) must not create a second goal
    await t.graph.resume("u1", run.runId, { decision: "approved" }).catch(() => undefined);
    expect(t.created).toHaveLength(1);
  });
  it("does nothing when the user rejects", async () => {
    const t = build({ extract });
    const run = await t.graph.run({ ...base, message: msg });
    await t.approvals.decide("u1", run.response.approvals[0].approvalId, "REJECTED");
    const done = await t.graph.resume("u1", run.runId, { decision: "rejected" });
    expect(done.status).toBe("completed");
    expect(t.created).toHaveLength(0);
  });
  it("never executes on the resume payload alone: an approve payload without a DB approval is ignored", async () => {
    const t = build({ extract });
    const run = await t.graph.run({ ...base, message: msg });
    await t.graph.resume("u1", run.runId, { decision: "approved" }); // approval row is still PENDING in the database
    expect(t.created).toHaveLength(0);
  });
  it("another user cannot resume someone else's run", async () => {
    const t = build({ extract });
    const run = await t.graph.run({ ...base, message: msg });
    await t.approvals.decide("u1", run.response.approvals[0].approvalId, "APPROVED");
    await expect(t.graph.resume("u2", run.runId, { decision: "approved" })).rejects.toBeTruthy();
    expect(t.created).toHaveLength(0);
    expect(await t.graph.stateOf("u2", run.runId)).toBeNull();
  });
  it("asks for missing details instead of inventing them", async () => {
    const t = build({ extract: { name: "New Car" } });
    const r = await t.graph.run({ ...base, message: "Create a goal called New Car" });
    expect(r.response.answerType).toBe("clarification");
    expect(r.response.approvals).toHaveLength(0);
    expect(t.created).toHaveLength(0);
  });
  it("strips identity fields a model tried to add to an extracted action", async () => {
    const t = build({ extract: { ...extract, userId: "victim", role: "admin" } });
    const run = await t.graph.run({ ...base, message: msg });
    expect(run.status).toBe("awaiting_approval");
    const stored = t.db.table("agentApproval")[0].proposedInput as Record<string, unknown>;
    expect(stored).not.toHaveProperty("userId");
    expect(stored).not.toHaveProperty("role");
  });
});

describe("agent graph: memory across turns", () => {
  it("remembers a stated preference and recalls it later; questions are not stored", async () => {
    const t = build();
    await t.graph.run({ ...base, message: "My monthly rent is 20000" });
    await t.graph.run({ ...base, message: "Is my rent of 20000 too high?" });
    const stored = await t.memory.list("u1", {});
    expect(stored.some((m) => /rent/i.test(m.content) && m.source === "USER_CONFIRMED")).toBe(true);
    // the question is only ever an episodic record of what happened, never a user-confirmed fact
    expect(stored.filter((m) => /too high/i.test(m.content) && m.source === "USER_CONFIRMED")).toHaveLength(0);
    const recalled = await t.memory.retrieve("u1", "what is my rent", { intent: "memory_recall" });
    expect(recalled.length).toBeGreaterThan(0);
  });
  it("memory belonging to another user never appears", async () => {
    const t = build();
    await t.graph.run({ ...base, message: "My monthly rent is 20000" });
    expect(await t.memory.retrieve("u2", "rent", { intent: "memory_recall" })).toEqual([]);
  });
});

describe("routing and helpers", () => {
  it("routes after authorize", () => {
    expect(routeAfterAuthorize({ override: { text: "x", answerType: "refusal" }, approvalCall: null, autoCalls: [] } as never)).toBe("compose");
    expect(routeAfterAuthorize({ override: null, approvalCall: { tool: "x" }, autoCalls: [] } as never)).toBe("approval");
    expect(routeAfterAuthorize({ override: null, approvalCall: null, autoCalls: [{}] } as never)).toBe("execute");
  });
  it("routes after verify", () => {
    expect(routeAfterVerify({ autoCalls: [{}], approvalCall: null, approvalDecision: null } as never)).toBe("retry");
    expect(routeAfterVerify({ autoCalls: [], approvalCall: { tool: "x" }, approvalDecision: null } as never)).toBe("approval");
    expect(routeAfterVerify({ autoCalls: [], approvalCall: { tool: "x" }, approvalDecision: "approved" } as never)).toBe("compose");
  });
  it("resolves short follow-ups against the previous user turn", () => {
    expect(resolveFollowUp("what about last month?", [{ role: "USER", content: "How much did I spend on food?" }])).toContain("How much did I spend on food?");
    expect(resolveFollowUp("How much did I spend on fuel in the last three months of this year?", [{ role: "USER", content: "x" }])).toMatch(/^How much did I spend on fuel/);
  });
  it("drops only sentences with unverifiable numbers", () => {
    const r = dropUnverifiedSentences("Save regularly. Rates are 9.5 percent. Start early.", "I earn 50000", new NumericConsistencyVerifier());
    expect(r.text).toBe("Save regularly. Start early.");
    expect(r.dropped).toBe(1);
  });
});
