import { PlannerService } from "../src/ai/coach/planning/planner.service";
import { ClassificationResult } from "../src/ai/coach/planning/intent-classifier.service";

describe("PlannerService.buildPlan", () => {
  const planner = new PlannerService();

  it("skips verification and composes for the deterministic path", () => {
    const classification: ClassificationResult = {
      path: "deterministic",
      intent: { id: "NET_WORTH", topicLabel: "net worth", patterns: [] },
    };
    const plan = planner.buildPlan(classification);
    expect(plan.needsVerification).toBe(false);
    expect(plan.needsComposition).toBe(true);
    expect(plan.steps.length).toBeGreaterThan(0);
    expect(plan.steps[0].description).toContain("NET_WORTH");
  });

  it("skips both composition and verification for general_search (RAG already grounds it)", () => {
    const classification: ClassificationResult = { path: "advanced", intent: "general_search", confidence: 0.5 };
    const plan = planner.buildPlan(classification);
    expect(plan.needsComposition).toBe(false);
    expect(plan.needsVerification).toBe(false);
  });

  it("requires both composition and verification for computed advanced intents", () => {
    for (const intent of ["prioritize_actions", "goal_conflict", "risk_tradeoff", "compare_periods"] as const) {
      const classification: ClassificationResult = { path: "advanced", intent, confidence: 0.8 };
      const plan = planner.buildPlan(classification);
      expect(plan.needsComposition).toBe(true);
      expect(plan.needsVerification).toBe(true);
    }
  });
});
