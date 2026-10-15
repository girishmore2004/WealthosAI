import { understandCoachQuestion, primaryAmount, parseDurationMonths, parsePeriod, extractCategoryHint } from "../src/ai/coach/analysis/question-understanding";

// Reference instant: 14 Oct 2026 (UTC).
const NOW = new Date("2026-10-14T06:00:00.000Z");
const u = (q: string) => understandCoachQuestion(q, NOW);

describe("understandCoachQuestion: the twelve required questions", () => {
  it("What is my current savings rate?", () => expect(u("What is my current savings rate?").kind).toBe("savings_rate"));

  it("How much did I spend on food last month? -> category + last month", () => {
    const r = u("How much did I spend on food last month?");
    expect(r.kind).toBe("category_spend");
    expect(r.categoryHint).toBe("food");
    expect(r.period?.months).toEqual(["2026-09"]);
    expect(r.period?.assumed).toBe(false);
  });

  it("What are my top expense categories? -> assumes this month, flagged as assumed", () => {
    const r = u("What are my top expense categories?");
    expect(r.kind).toBe("top_categories");
    expect(r.period?.months).toEqual(["2026-10"]);
    expect(r.period?.assumed).toBe(true);
  });

  it("Am I on track for my retirement goal?", () => expect(u("Am I on track for my retirement goal?").kind).toBe("retirement_on_track"));

  it("What if I increase my SIP by ₹5,000 per month?", () => {
    const r = u("What if I increase my SIP by ₹5,000 per month?");
    expect(r.kind).toBe("what_if");
    expect(r.whatIf).toEqual({ type: "SIP_INCREASE", amount: 5000 });
  });

  it("Can I afford a ₹40 lakh house next year?", () => {
    const r = u("Can I afford a ₹40 lakh house next year?");
    expect(r.kind).toBe("house_affordability");
    expect(r.house?.price).toBe(4_000_000);
    expect(r.house?.horizonMonths).toBe(12);
    expect(r.house?.downPaymentPercent).toBeUndefined();
  });

  it("What happens if I prepay ₹2 lakh of my loan?", () => {
    const r = u("What happens if I prepay ₹2 lakh of my loan?");
    expect(r.kind).toBe("what_if");
    expect(r.whatIf?.type).toBe("LOAN_PREPAYMENT");
    expect(r.whatIf?.amount).toBe(200_000);
  });

  it("Show my emergency-fund adequacy.", () => expect(u("Show my emergency-fund adequacy.").kind).toBe("emergency_fund"));
  it("Explain my insurance coverage from my uploaded policy.", () => expect(u("Explain my insurance coverage from my uploaded policy.").kind).toBe("insurance_document"));

  it("Create a plan to save ₹10 lakh in three years.", () => {
    const r = u("Create a plan to save ₹10 lakh in three years.");
    expect(r.kind).toBe("savings_plan");
    expect(r.plan).toEqual({ targetAmount: 1_000_000, months: 36 });
  });

  it("Should I prepay my loan or increase my SIP?", () => expect(u("Should I prepay my loan or increase my SIP?").kind).toBe("prepay_vs_sip"));
  it("What is the best way to reach my goal faster?", () => expect(u("What is the best way to reach my goal faster?").kind).toBe("goal_acceleration"));
});

describe("understandCoachQuestion: other behaviour", () => {
  it("defers questions it does not own", () => {
    expect(u("What's my net worth?").kind).toBe("defer");
    expect(u("What's my tax situation?").kind).toBe("defer");
  });
  it("asks one clarification when the house price is missing", () => {
    const r = u("Can I afford to buy a house?");
    expect(r.kind).toBe("clarification");
    expect(r.clarification).toMatch(/price/i);
  });
  it("a what-if it cannot type still goes to what_if with a null type (Scenario Studio interprets it)", () => {
    const r = u("What if I move to another city?");
    expect(r.kind).toBe("what_if");
    expect(r.whatIf?.type).toBeNull();
  });
  it("reads explicit house terms", () => {
    const r = u("Can I buy a house for ₹50 lakh with 30% down payment at 9% interest for 15 years?");
    expect(r.house).toMatchObject({ price: 5_000_000, downPaymentPercent: 30, annualRatePercent: 9, tenureYears: 15 });
  });
  it("is a pure function of the question text (no I/O, same input -> same output)", () => {
    expect(u("What is my savings rate?")).toEqual(u("What is my savings rate?"));
  });
});

describe("parsers", () => {
  it("amounts: lakh, crore, k, commas, bare numbers; ignores years and percents", () => {
    expect(primaryAmount("₹2 lakh")).toBe(200_000);
    expect(primaryAmount("1.5 crore")).toBe(15_000_000);
    expect(primaryAmount("add 5k")).toBe(5000);
    expect(primaryAmount("save 3 years of 25,000")).toBe(25_000);
    expect(primaryAmount("in 3 years at 8%")).toBeNull();
  });
  it("durations", () => {
    expect(parseDurationMonths("in 18 months")).toBe(18);
    expect(parseDurationMonths("over five years")).toBe(60);
    expect(parseDurationMonths("next year")).toBe(12);
    expect(parseDurationMonths("soon")).toBeNull();
  });
  it("periods: previous year rollover, named months, last N complete months", () => {
    expect(parsePeriod("last month", new Date("2026-01-05T00:00:00Z"))?.months).toEqual(["2025-12"]);
    expect(parsePeriod("what did I spend in December", NOW)?.months).toEqual(["2025-12"]);
    expect(parsePeriod("in September 2026", NOW)?.months).toEqual(["2026-09"]);
    expect(parsePeriod("over the last 3 months", NOW)?.months).toEqual(["2026-07", "2026-08", "2026-09"]);
  });
  it("category hints", () => {
    expect(extractCategoryHint("How much did I spend on dining out last month?")).toBe("dining out");
    expect(extractCategoryHint("how much did I spend last month")).toBeNull();
  });
});

describe("house terms", () => {
  it("reads 'at 9%' as the loan rate but not '30% down' as a rate", () => {
    const u = understandCoachQuestion("Can I afford a house worth ₹40 lakh with 30% down at 9% for 15 years?", new Date("2026-10-15T06:00:00Z"));
    expect(u.kind).toBe("house_affordability");
    expect(u.house).toMatchObject({ price: 4000000, downPaymentPercent: 30, annualRatePercent: 9, tenureYears: 15 });
  });
});
