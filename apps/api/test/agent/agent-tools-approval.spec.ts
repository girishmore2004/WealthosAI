import { z } from "zod";
import { fakePrisma } from "./fake-prisma";
import { ToolRegistryService, redactArgs } from "../../src/ai/agent/tools/tool-registry.service";
import { AgentApprovalService, idempotencyKeyFor } from "../../src/ai/agent/approval/agent-approval.service";
import { AgentTool, ToolForbiddenError, requiresApproval } from "../../src/ai/agent/tools/agent-tool.types";

const ctx = { userId: "u1", conversationId: "c1", runId: "r1" };

function setup() {
  const db = fakePrisma();
  const registry = new ToolRegistryService(db as never);
  const executed: unknown[] = [];
  const mk = (over: Partial<AgentTool> & { name: string }): AgentTool => ({
    description: "t",
    risk: "LOW",
    schema: z.object({ q: z.string().max(50) }).strict(),
    execute: async (_c, input) => {
      executed.push(input);
      return { text: "done" };
    },
    ...over,
  } as AgentTool);
  return { db, registry, executed, mk };
}

describe("tool registry: allowlist, schema, risk gates", () => {
  it("denies tools that are not registered, and audits the denial", async () => {
    const { registry, db } = setup();
    const out = await registry.invoke(ctx, "transfer_money", { amount: 1 }, { callId: "k" });
    expect(out.status).toBe("denied");
    expect(out.errorCode).toBe("TOOL_NOT_ALLOWED");
    expect(db.table("agentToolExecution")[0]).toMatchObject({ status: "DENIED", toolName: "transfer_money", userId: "u1" });
  });
  it("rejects identity/privilege keys in arguments instead of cleaning them", async () => {
    const { registry, mk, executed } = setup();
    registry.register(mk({ name: "read" }));
    const out = await registry.invoke(ctx, "read", { q: "x", userId: "someone-else" }, { callId: "k" });
    expect(out.status).toBe("denied");
    expect(out.errorCode).toBe("FORBIDDEN_ARGUMENT");
    expect(executed).toHaveLength(0);
    expect(registry.authorize("read", { q: "x", role: "admin" })).toMatchObject({ gate: "denied" });
  });
  it("rejects unknown fields and invalid values (strict schema)", async () => {
    const { registry, mk, executed } = setup();
    registry.register(mk({ name: "read" }));
    expect((await registry.invoke(ctx, "read", { q: "x", extra: 1 }, { callId: "k" })).errorCode).toBe("INVALID_INPUT");
    expect((await registry.invoke(ctx, "read", { q: "y".repeat(80) }, { callId: "k" })).errorCode).toBe("INVALID_INPUT");
    expect(executed).toHaveLength(0);
  });
  it("applies the risk policy: LOW auto, MEDIUM approval unless 'never', HIGH always", () => {
    expect(requiresApproval({ risk: "LOW" })).toBe(false);
    expect(requiresApproval({ risk: "MEDIUM" })).toBe(true);
    expect(requiresApproval({ risk: "MEDIUM", approval: "never" })).toBe(false);
    expect(requiresApproval({ risk: "HIGH", approval: "never" })).toBe(true);
  });
  it("refuses to execute an approval-gated tool without approval, and runs it with one", async () => {
    const { registry, mk, executed } = setup();
    registry.register(mk({ name: "create_goal", risk: "HIGH" }));
    const blocked = await registry.invoke(ctx, "create_goal", { q: "x" }, { callId: "k" });
    expect(blocked.status).toBe("denied");
    expect(blocked.errorCode).toBe("APPROVAL_REQUIRED");
    expect(executed).toHaveLength(0);
    const ok = await registry.invoke(ctx, "create_goal", { q: "x" }, { callId: "k2", approval: { approvalId: "a1" } });
    expect(ok.status).toBe("ok");
    expect(executed).toHaveLength(1);
  });
  it("hides other users' resources as not found (authorization)", async () => {
    const { registry, mk, executed } = setup();
    registry.register(mk({ name: "update_goal", authorizeResources: async () => { throw new ToolForbiddenError(); } }));
    const out = await registry.invoke(ctx, "update_goal", { q: "x" }, { callId: "k" });
    expect(out.errorCode).toBe("NOT_FOUND");
    expect(out.text).not.toMatch(/forbidden|another user/i);
    expect(executed).toHaveLength(0);
  });
  it("is idempotent: the same key returns the first result and does not act twice", async () => {
    const { registry, mk, executed } = setup();
    registry.register(mk({ name: "create_goal", risk: "HIGH" }));
    const opts = { callId: "k", approval: { approvalId: "a1" }, idempotencyKey: "same" };
    await registry.invoke(ctx, "create_goal", { q: "x" }, opts);
    const second = await registry.invoke(ctx, "create_goal", { q: "x" }, { ...opts, callId: "k2" });
    expect(executed).toHaveLength(1);
    expect(second.data).toMatchObject({ duplicate: true });
  });
  it("a failed run does not hold the idempotency slot and is retried only for transient errors", async () => {
    const { registry, mk, db } = setup();
    let calls = 0;
    registry.register(mk({ name: "flaky", execute: async () => { calls += 1; throw Object.assign(new Error("x"), { status: 503 }); } }));
    const out = await registry.invoke(ctx, "flaky", { q: "x" }, { callId: "k", idempotencyKey: "i" });
    expect(out.status).toBe("error");
    expect(calls).toBe(2); // 1 try + AGENT_MAX_TOOL_RETRIES(1)
    expect(db.table("agentToolExecution")[0].idempotencyKey).toBeNull();
    let hard = 0;
    registry.register(mk({ name: "broken", execute: async () => { hard += 1; throw new Error("bug"); } }));
    await registry.invoke(ctx, "broken", { q: "x" }, { callId: "k" });
    expect(hard).toBe(1);
  });
  it("times out slow tools", async () => {
    const { registry, mk } = setup();
    registry.register(mk({ name: "slow", timeoutMs: 20, execute: () => new Promise(() => undefined) }));
    const out = await registry.invoke(ctx, "slow", { q: "x" }, { callId: "k" });
    expect(out.status).toBe("error");
  });
  it("scrubs PII from the audit record", () => {
    const red = JSON.stringify(redactArgs({ note: "call me at 9876543210 or a@b.com", n: { pan: "ABCDE1234F" } }));
    expect(red).not.toContain("9876543210");
    expect(red).not.toContain("a@b.com");
  });
  it("rejects duplicate registration", () => {
    const { registry, mk } = setup();
    registry.register(mk({ name: "x" }));
    expect(() => registry.register(mk({ name: "x" }))).toThrow();
  });
});

describe("approvals", () => {
  const base = { userId: "u1", conversationId: "c1", threadId: "t1", toolName: "create_goal", risk: "HIGH" as const, summary: "Create goal", input: { name: "Car", targetAmount: 100 } };
  it("key is stable regardless of argument order", () => {
    expect(idempotencyKeyFor("t", { a: 1, b: { c: 2, d: 3 } })).toBe(idempotencyKeyFor("t", { b: { d: 3, c: 2 }, a: 1 }));
    expect(idempotencyKeyFor("t", { a: 1 })).not.toBe(idempotencyKeyFor("t", { a: 2 }));
  });
  it("reuses a pending approval for the same request", async () => {
    const svc = new AgentApprovalService(fakePrisma() as never);
    const a = await svc.createOrReuse(base);
    const b = await svc.createOrReuse(base);
    expect(b.id).toBe(a.id);
  });
  it("decides once only (replay and double click are no-ops)", async () => {
    const svc = new AgentApprovalService(fakePrisma() as never);
    const a = await svc.createOrReuse(base);
    expect((await svc.decide("u1", a.id, "APPROVED"))?.status).toBe("APPROVED");
    expect(await svc.decide("u1", a.id, "REJECTED")).toBeNull();
    expect((await svc.get("u1", a.id)).status).toBe("APPROVED");
  });
  it("another user cannot read or decide it", async () => {
    const svc = new AgentApprovalService(fakePrisma() as never);
    const a = await svc.createOrReuse(base);
    await expect(svc.get("u2", a.id)).rejects.toThrow(/not found/i);
    expect(await svc.decide("u2", a.id, "APPROVED")).toBeNull();
    expect((await svc.get("u1", a.id)).status).toBe("PENDING");
  });
  it("expired approvals cannot be approved", async () => {
    const db = fakePrisma();
    const svc = new AgentApprovalService(db as never);
    const a = await svc.createOrReuse(base);
    db.table("agentApproval")[0].expiresAt = new Date(Date.now() - 1000);
    expect(await svc.decide("u1", a.id, "APPROVED")).toBeNull();
    expect((await svc.get("u1", a.id)).status).toBe("EXPIRED");
  });
});
