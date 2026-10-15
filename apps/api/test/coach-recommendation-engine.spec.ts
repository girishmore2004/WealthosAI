import { buildRecommendations, derivePreferences, NO_PREFERENCES, RecommendationFacts } from "../src/ai/coach/analysis/recommendation-engine";
import { GoalAssessment } from "../src/ai/coach/analysis/coach-metrics";

const goal = (over: Partial<GoalAssessment> = {}): GoalAssessment => ({
  id: "g1", name: "Car", state: "ACTIVE", target: 500000, saved: 100000, shortfall: 400000, progressPercent: 20,
  monthlyContribution: 10000, requiredMonthly: 33333, paceRatio: 0.3, monthsLeft: 12, onTrack: false, staleRequirement: false, ...over,
});

const healthy: RecommendationFacts = {
  monthlyIncome: 150000, monthlySpending: 60000, monthlySurplus: 50000,
  emergency: { verdict: "adequate", shortfall: 0, coverageMonths: 6.5, targetMonths: 6, targetIsDefault: false },
  loans: [], emiToIncome: 0.2, goals: [], retirement: null, insuranceGaps: [], categoryIncreases: [], preferences: NO_PREFERENCES,
};

describe("buildRecommendations: ranking", () => {
  it("is deterministic and orders by tier: liquidity, then debt, then goals, then optimisation", () => {
    const facts: RecommendationFacts = {
      ...healthy,
      emergency: { verdict: "partial", shortfall: 120000, coverageMonths: 4, targetMonths: 6, targetIsDefault: true },
      loans: [{ id: "l1", lender: "HDFC", type: "PERSONAL", ratePercent: 14, outstanding: 300000, emi: 12000 }],
      goals: [goal()],
      insuranceGaps: [{ type: "TERM_LIFE", gap: 5000000, hasCoverage: true }],
      categoryIncreases: [{ name: "Food", monthlyIncrease: 4000, ratio: 0.5 }],
    };
    const a = buildRecommendations(facts);
    const b = buildRecommendations(facts);
    expect(a).toEqual(b);
    expect(a.recommendations.map((r) => r.id)).toEqual(["emergency-fund-top-up", "prepay-l1", "goal-behind-g1", "category-spike-food", "insurance-gap"]);
    expect(a.recommendations.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
    expect(a.recommendations[1].estimatedImpact!.display).toContain("42,000"); // 300000 x 14%
  });

  it("every recommendation carries the required explainability fields", () => {
    const r = buildRecommendations({ ...healthy, loans: [{ id: "l1", lender: "HDFC", type: "PERSONAL", ratePercent: 14, outstanding: 300000, emi: 12000 }], goals: [goal()] });
    for (const rec of r.recommendations) {
      expect(rec.issue).toBeTruthy();
      expect(rec.evidence.length).toBeGreaterThan(0);
      expect(rec.whyItMatters).toBeTruthy();
      expect(rec.nextStep).toBeTruthy();
      expect(rec.priority.reason).toBeTruthy();
      expect(rec.feasibility).toBeTruthy();
      expect(rec.destination?.href).toMatch(/^\//);
    }
  });

  it("a healthy position yields no recommendations (nothing is manufactured)", () => {
    expect(buildRecommendations(healthy).recommendations).toEqual([]);
  });
});

describe("buildRecommendations: safeguards", () => {
  it("never recommends investing or prepaying while the emergency fund is low; the emergency recommendation leads", () => {
    const r = buildRecommendations({
      ...healthy,
      emergency: { verdict: "low", shortfall: 250000, coverageMonths: 1.2, targetMonths: 6, targetIsDefault: false },
      loans: [{ id: "l1", lender: "HDFC", type: "PERSONAL", ratePercent: 14, outstanding: 300000, emi: 12000 }],
      goals: [goal()],
      retirement: { onTrack: false, corpusGap: 5000000, requiredMonthlySip: 20000, yearsToRetirement: 25 },
    });
    expect(r.recommendations.map((x) => x.id)).toEqual(["emergency-fund-top-up"]);
    expect(r.recommendations[0].priority.level).toBe("urgent");
    expect(r.suppressed.length).toBe(3);
  });

  it("negative cash flow comes first and blocks investment advice", () => {
    const r = buildRecommendations({ ...healthy, monthlySurplus: -8000, monthlyIncome: 50000, monthlySpending: 58000, goals: [goal()] });
    expect(r.recommendations[0].id).toBe("cash-flow-deficit");
    expect(r.recommendations.some((x) => x.id.startsWith("goal-behind"))).toBe(false);
  });

  it("a stated preference removes the recommendation and reports that it did", () => {
    const prefs = derivePreferences(["Don't prepay my loans, I want liquidity", "no more SIP increases for now"]);
    expect(prefs.avoidDebtPrepayment).toBe(true);
    const r = buildRecommendations({ ...healthy, loans: [{ id: "l1", lender: "HDFC", type: "PERSONAL", ratePercent: 14, outstanding: 300000, emi: 12000 }], preferences: prefs });
    expect(r.recommendations.some((x) => x.id === "prepay-l1")).toBe(false);
    expect(r.suppressed[0]).toMatch(/asked to avoid prepaying/);
  });

  it("feasibility is checked against surplus, and unknown surplus is said to be unknown", () => {
    const tight = buildRecommendations({ ...healthy, monthlySurplus: 5000, goals: [goal()] }).recommendations[0];
    expect(tight.feasibility).toMatch(/Exceeds/);
    const unknown = buildRecommendations({ ...healthy, monthlySurplus: null, goals: [goal()] }).recommendations[0];
    expect(unknown.feasibility).toMatch(/Cannot be checked/);
  });

  it("overdue goals get a decision, not an invented monthly amount; funded goals get nothing", () => {
    const r = buildRecommendations({ ...healthy, goals: [goal({ id: "o", state: "OVERDUE", requiredMonthly: null, onTrack: false, monthsLeft: 0 }), goal({ id: "f", state: "FUNDED", requiredMonthly: 0, onTrack: true, shortfall: 0, staleRequirement: true })] });
    expect(r.recommendations.map((x) => x.id)).toEqual(["goal-overdue-o"]);
  });
});

describe("derivePreferences", () => {
  it("reads emergency-fund protection and ignores unrelated text", () => {
    expect(derivePreferences(["don't touch my emergency fund"]).protectEmergencyFund).toBe(true);
    expect(derivePreferences(["prefers avalanche over snowball"])).toEqual(NO_PREFERENCES);
  });
});
