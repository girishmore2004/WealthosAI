jest.mock("@wealthos/db", () => ({ ...jest.requireActual("@prisma/client"), prisma: {} }));
jest.mock("../../src/prisma/prisma.service", () => ({ PrismaService: class {} }));
import { z } from "zod";
import { classifyIntentRules } from "../../src/ai/agent/intent/intent-rules";
import { AgentIntentService, resolveFollowUp } from "../../src/ai/agent/intent/agent-intent.service";
import { dropNulls, inferGoalType, nullTolerant } from "../../src/ai/agent/planning/action-extractor.service";
import { formatMoney } from "../../src/ai/agent/analysis/financial-verification";
import { referenceIncome } from "../../src/ai/agent/analysis/financial-audit";

describe("live-deployment regression fixes", () => {
  describe("intent rules", () => {
    it("treats a complete-audit request as a read-only analysis, never an action", () => {
      for (const m of ["Give me a complete financial audit of my account.", "Review my finances", "Give me a financial health check"]) {
        const r = classifyIntentRules(m, { hasAttachments: false });
        expect(r.intent).toBe("financial_analysis");
        expect(r.actionTool).toBeUndefined();
      }
    });
    it("routes uploaded-document searches to document questions", () => {
      for (const m of ["Search my uploaded financial documents.", "Look through my uploaded statements and cite the sources"]) {
        expect(classifyIntentRules(m, { hasAttachments: false }).intent).toBe("document_question");
      }
    });
  });

  describe("follow-up resolution", () => {
    const history = [{ role: "USER" as const, content: "Give me a complete financial audit of my account." }];
    it("does not merge a short message that names its own topic", () => {
      expect(resolveFollowUp("Check my insurance premiums.", history)).toBe("Check my insurance premiums.");
    });
    it("still merges a genuine follow-up", () => {
      expect(resolveFollowUp("what about last month?", history)).toContain("(follow-up: what about last month?)");
    });
  });

  describe("model intent fallback", () => {
    it("downgrades a model-suggested action with no matching action wording to a read-only question", async () => {
      const gateway = { classify: jest.fn().mockResolvedValue({ data: { label: "action_request" }, confidence: 0.9 }) };
      const svc = new AgentIntentService(gateway as never);
      const r = await svc.understand("u1", "hmm the thing about stuff", { hasAttachments: false, history: [] });
      expect(r.intent).not.toBe("action_request");
      expect(r.actionTool).toBeUndefined();
    });
  });

  describe("null-tolerant action extraction", () => {
    const schema = z.object({ type: z.enum(["CAR", "HOUSE"]), name: z.string(), monthlyContribution: z.number().default(0) });
    it("accepts nulls for fields the user did not state and drops them", () => {
      const parsed = nullTolerant(schema).safeParse({ type: null, name: "New Car", monthlyContribution: null });
      expect(parsed.success).toBe(true);
      expect(dropNulls(parsed.success ? parsed.data : {})).toEqual({ name: "New Car" });
    });
  });

  describe("improvement plan routing", () => {
    it("sends 'create an improvement plan' to planning, not to a goal/plan write", () => {
      const r = classifyIntentRules("Create an improvement plan for my finances.", { hasAttachments: false });
      expect(r.intent).toBe("planning");
      expect(r.actionTool).toBeUndefined();
    });
  });

  describe("goal type inference", () => {
    it("reads the type from the user's own words only when exactly one type is named", () => {
      expect(inferGoalType("Create a goal called New Car for ₹8 lakh by 2028-03-31.")).toBe("CAR");
      expect(inferGoalType("goal for a house down payment")).toBe("HOUSE");
      expect(inferGoalType("goal for a car and a house")).toBeNull();
      expect(inferGoalType("goal called Something")).toBeNull();
    });
  });

  describe("money formatting", () => {
    it("puts the minus sign before the rupee symbol", () => {
      expect(formatMoney(-20121)).toBe("−₹20,121");
      expect(formatMoney(22457)).toBe("₹22,457");
    });
  });

  describe("reference income", () => {
    const now = new Date("2026-11-12T00:00:00Z");
    const rows = [
      { receivedAt: new Date("2026-10-05T00:00:00Z"), amount: 60000 },
      { receivedAt: new Date("2026-09-05T00:00:00Z"), amount: 40000 },
    ];
    it("averages complete months only when this month has no income", () => {
      const ref = referenceIncome(rows, 0, now);
      expect(ref?.amount).toBe(50000);
      expect(ref?.basis).toMatch(/last 2 complete months/);
    });
    it("is not used when this month already has income, or when there is no history", () => {
      expect(referenceIncome(rows, 30000, now)).toBeNull();
      expect(referenceIncome([], 0, now)).toBeNull();
    });
  });
});
