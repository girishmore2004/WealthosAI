jest.mock("../src/ai/financial-engine/financial-tools.service", () => ({ FinancialToolsService: class {} }));

import { routeIntent, parseRupeeAmount } from "../src/ai/financial-engine/financial-intents";
import { calculateScenario } from "../src/ai/financial-engine/scenario-planner";
import { verifyAnswer } from "../src/ai/financial-engine/numeric-verifier";
import { composeAnswer } from "../src/ai/financial-engine/answer-composer";
import { FinancialEngineService } from "../src/ai/financial-engine/financial-engine.service";
import { FactValue, ToolResult } from "../src/ai/financial-engine/financial-types";

const money = (v: string): FactValue => ({ kind: "MONEY", value: v });
const ratio = (v: string): FactValue => ({ kind: "RATIO", value: v });
const base = { basis: "ACTUAL" as const, asOfDate: "2026-10-03T00:00:00.000Z", warnings: [], missing: [] };

// Spec fixture: income 65,000, expenses 15,000, investments 10,000, emergency allocation 7,000.
const cashFlow = (over: Partial<ToolResult> = {}): ToolResult => ({
  ...base,
  tool: "getCashFlow",
  period: "MONTHLY",
  facts: {
    income: money("65000.00"), expenses: money("15000.00"), investmentContributions: money("10000.00"),
    emergencyAllocations: money("7000.00"), netCashFlow: money("33000.00"),
    savingsRate: ratio("0.769230769230769"), investmentRate: ratio("0.153846153846154"), expenseRate: ratio("0.230769230769231"),
  },
  ...over,
});
const position = (): ToolResult => ({
  ...base, tool: "getNetWorth", period: "LIFETIME",
  facts: {
    availableCash: money("33000.00"), emergencyCash: money("7000.00"), totalCash: money("40000.00"),
    investmentValue: money("100000.00"), property: money("0.00"), loans: money("0.00"),
    totalAssets: money("140000.00"), totalLiabilities: money("0.00"), netWorth: money("140000.00"),
  },
});

describe("intent router", () => {
  it("routes 'How much did I invest this month?' to a calculation intent", () => {
    expect(routeIntent("How much did I invest this month?")).toEqual({ intent: "FINANCIAL_CALCULATION", metric: "INVESTED" });
  });
  it("routes the SIP scenario and parses the amount", () => {
    const r = routeIntent("What happens if I increase my SIP by ₹5,000?");
    expect(r.intent).toBe("SCENARIO");
    expect(r.scenario).toEqual({ kind: "SIP_CHANGE", direction: "INCREASE", amount: "5000.00", percent: null });
  });
  it("routes a question about what a policy says to the document intent, not insurance numbers", () => {
    expect(routeIntent("What does my insurance policy say about renewal?").intent).toBe("DOCUMENT_QUERY");
  });
  it("routes net worth, emergency fund, savings rate and education questions", () => {
    expect(routeIntent("What is my current net worth?").intent).toBe("NET_WORTH");
    expect(routeIntent("How many months of emergency coverage do I have?").intent).toBe("EMERGENCY_FUND");
    expect(routeIntent("what's my savings rate").metric).toBe("SAVINGS_RATE");
    expect(routeIntent("explain what an index fund is").intent).toBe("GENERAL_FINANCIAL_EDUCATION");
  });
  it("parses percent changes and marks unmodelled scenarios unsupported", () => {
    expect(routeIntent("what if my salary goes up, increase by 10%").scenario).toMatchObject({ kind: "SALARY_CHANGE", percent: "10" });
    expect(routeIntent("what if I prepay my home loan by ₹2 lakh").scenario?.kind).toBe("UNSUPPORTED");
  });
  it("parses rupee amounts in several forms and ignores bare counts", () => {
    expect(parseRupeeAmount("by 5k")).toBe("5000.00");
    expect(parseRupeeAmount("₹2.5 lakh")).toBe("250000.00");
    expect(parseRupeeAmount("rs 1,50,000")).toBe("150000.00");
    expect(parseRupeeAmount("for 3 months")).toBeNull();
  });
});

describe("scenario planner (SIP +₹5,000)", () => {
  const baseline = { income: "65000.00", expenses: "15000.00", investmentContributions: "10000.00", emergencyAllocations: "7000.00" };
  const sip = { kind: "SIP_CHANGE" as const, direction: "INCREASE" as const, amount: "5000.00", percent: null };

  it("computes current vs scenario cash left, marks it PROJECTED and never mutates", () => {
    const o = calculateScenario(baseline, sip)!;
    expect(o.mutatesData).toBe(false);
    expect(o.basis).toBe("PROJECTED");
    expect(o.facts.currentMonthlyCashLeft.value).toBe("33000.00");
    expect(o.facts.scenarioMonthlyCashLeft.value).toBe("28000.00");
    expect(o.facts.monthlyDifference.value).toBe("5000.00");
    expect(o.facts.twelveMonthDifference.value).toBe("60000.00");
    expect(o.facts.scenarioContributions.value).toBe("15000.00");
  });
  it("leaves the savings rate unchanged for a SIP (not an expense) and explains why", () => {
    const o = calculateScenario(baseline, sip)!;
    expect(o.facts.scenarioSavingsRate.value).toBe(o.facts.currentSavingsRate.value);
    expect(o.notes.join(" ")).toMatch(/not spending/);
  });
  it("applies a salary percentage and an expense increase", () => {
    const sal = calculateScenario(baseline, { kind: "SALARY_CHANGE", direction: "INCREASE", amount: null, percent: "10" })!;
    expect(sal.facts.scenarioIncome.value).toBe("71500.00");
    const exp = calculateScenario(baseline, { kind: "EXPENSE_CHANGE", direction: "INCREASE", amount: "2000.00", percent: null })!;
    expect(exp.facts.scenarioMonthlyCashLeft.value).toBe("31000.00");
  });
  it("caps a decrease at the current amount and warns when commitments exceed income", () => {
    const cut = calculateScenario(baseline, { ...sip, direction: "DECREASE", amount: "50000.00" })!;
    expect(cut.facts.scenarioContributions.value).toBe("0.00");
    expect(cut.warnings.join(" ")).toMatch(/capped/);
    const big = calculateScenario(baseline, { ...sip, amount: "40000.00" })!;
    expect(big.warnings.join(" ")).toMatch(/exceed your monthly income/);
  });
  it("returns null without a size or for unsupported kinds", () => {
    expect(calculateScenario(baseline, { ...sip, amount: null })).toBeNull();
    expect(calculateScenario(baseline, { ...sip, kind: "UNSUPPORTED" })).toBeNull();
  });
});

describe("numeric verifier", () => {
  it("accepts text whose figures all come from the facts", () => {
    expect(verifyAnswer("This month you invested ₹10,000 and your savings rate is 76.9%.", [cashFlow()]).passed).toBe(true);
  });
  it("rejects an invented amount", () => {
    const r = verifyAnswer("You invested ₹12,000 this month.", [cashFlow()]);
    expect(r.passed).toBe(false);
    expect(r.issues[0].code).toBe("UNSUPPORTED_NUMBER");
  });
  it("catches a ratio multiplied by 100 twice (0.25 shown as 2500%)", () => {
    const tool = cashFlow({ facts: { savingsRate: ratio("0.25") } });
    expect(verifyAnswer("Your savings rate this month is 25.0%.", [tool]).passed).toBe(true);
    const bad = verifyAnswer("Your savings rate this month is 2500%.", [tool]);
    expect(bad.passed).toBe(false);
    expect(bad.issues[0].code).toBe("DOUBLE_PERCENT_SCALE");
  });
  it("flags totals that do not reconcile", () => {
    const broken = position();
    broken.facts.totalCash = money("41000.00");
    expect(verifyAnswer("Total cash is ₹41,000.", [broken]).issues.map((i) => i.code)).toContain("TOTALS_DO_NOT_RECONCILE");
  });
  it("requires non-actual bases to be labelled", () => {
    const projected = cashFlow({ basis: "PROJECTED" });
    expect(verifyAnswer("This month you would invest ₹10,000.", [projected]).issues.map((i) => i.code)).toContain("BASIS_NOT_LABELED");
    expect(verifyAnswer("Projected for this month: ₹10,000.", [projected]).passed).toBe(true);
  });
  it("flags 'this month' answers built from non-monthly facts", () => {
    expect(verifyAnswer("This month your net worth is ₹1,40,000.", [position()]).issues.map((i) => i.code)).toContain("PERIOD_MISMATCH");
  });
});

describe("composer + verifier (every composed answer must verify)", () => {
  const cases: Array<[string, ReturnType<typeof routeIntent>, ToolResult[]]> = [
    ["invested", { intent: "FINANCIAL_CALCULATION", metric: "INVESTED" }, [cashFlow()]],
    ["spent", { intent: "FINANCIAL_CALCULATION", metric: "SPENT" }, [cashFlow()]],
    ["savings rate", { intent: "FINANCIAL_CALCULATION", metric: "SAVINGS_RATE" }, [cashFlow()]],
    ["investment rate", { intent: "FINANCIAL_CALCULATION", metric: "INVESTMENT_RATE" }, [cashFlow()]],
    ["net worth", { intent: "NET_WORTH" }, [position()]],
    ["cash flow", { intent: "CASH_FLOW" }, [position(), cashFlow()]],
    ["summary", { intent: "FINANCIAL_SUMMARY" }, [position(), cashFlow()]],
    ["expenses", { intent: "EXPENSE_ANALYSIS" }, [cashFlow()]],
  ];
  it.each(cases)("%s", (_n, routed, tools) => {
    const text = composeAnswer(routed, tools);
    expect(text.length).toBeGreaterThan(10);
    expect(text).not.toMatch(/null|undefined|NaN/);
    expect(verifyAnswer(text, tools)).toEqual({ passed: true, issues: [] });
  });

  it("states the savings rate once, as 76.9%", () => {
    const text = composeAnswer({ intent: "FINANCIAL_CALCULATION", metric: "SAVINGS_RATE" }, [cashFlow()]);
    expect(text).toContain("76.9%");
    expect(text).not.toContain("7692");
  });

  it("mentions a known SIP-as-expense inconsistency and still verifies", () => {
    const flagged = cashFlow({ warnings: [{ code: "INVESTMENT_AS_EXPENSE", severity: "WARNING", message: "m", count: 1, amount: "10000.00" }] });
    const text = composeAnswer({ intent: "FINANCIAL_CALCULATION", metric: "INVESTED" }, [flagged]);
    expect(text).toMatch(/still recorded as expenses/);
    expect(verifyAnswer(text, [flagged]).passed).toBe(true);
  });

  it("says data is missing rather than inventing a rate", () => {
    const noIncome = cashFlow({ facts: { income: money("0.00"), expenses: money("500.00"), investmentContributions: money("0.00"), emergencyAllocations: money("0.00"), netCashFlow: money("0.00") }, missing: ["rates (no income recorded this month)"] });
    expect(composeAnswer({ intent: "FINANCIAL_CALCULATION", metric: "SAVINGS_RATE" }, [noIncome])).toMatch(/can't compute a savings rate/);
  });
});

describe("FinancialEngineService", () => {
  const scenarioTool = (): ToolResult => {
    const o = calculateScenario(
      { income: "65000.00", expenses: "15000.00", investmentContributions: "10000.00", emergencyAllocations: "7000.00" },
      { kind: "SIP_CHANGE", direction: "INCREASE", amount: "5000.00", percent: null },
    )!;
    return {
      ...base, tool: "calculateScenario", basis: "PROJECTED", period: "MONTHLY", facts: o.facts, missing: [],
      warnings: o.notes.map((message) => ({ code: "SCENARIO_NOTE", severity: "INFO" as const, message, count: 1 })),
    };
  };
  const healthTool = (): ToolResult => ({ ...base, tool: "getDataHealth", period: "CUSTOM", facts: {}, warnings: [], missing: [] });
  const makeTools = () => ({
    getCashFlow: jest.fn().mockResolvedValue(cashFlow()),
    getNetWorth: jest.fn().mockResolvedValue(position()),
    getFinancialFacts: jest.fn().mockResolvedValue([position(), cashFlow()]),
    calculateScenario: jest.fn().mockResolvedValue(scenarioTool()),
    getDataHealth: jest.fn().mockResolvedValue(healthTool()),
    calculateEmergencyCoverage: jest.fn(), getInvestmentSummary: jest.fn(), getInsuranceSummary: jest.fn(), getLoanSummary: jest.fn(),
  });

  it("'How much did I invest this month?' uses the facts tool and answers with the contribution only", async () => {
    const tools = makeTools();
    const res = await new FinancialEngineService(tools as never).ask("user-1", "How much did I invest this month?");

    expect(res.intent).toBe("FINANCIAL_CALCULATION");
    expect(tools.getCashFlow).toHaveBeenCalledWith("user-1");
    expect(res.handled).toBe(true);
    expect(res.answer).toContain("₹10,000");
    expect(res.answer).not.toContain("₹15,000"); // expenses are not part of the invested figure
    expect(res.verification.passed).toBe(true);
    expect(res.usedFallback).toBe(false);
    expect(res.tools[0]).toMatchObject({ tool: "getCashFlow", basis: "ACTUAL", period: "MONTHLY" });
  });

  it("answers the SIP scenario as projected, with current vs scenario cash, without any write tool", async () => {
    const tools = makeTools();
    const res = await new FinancialEngineService(tools as never).ask("user-1", "What happens if I increase my SIP by ₹5,000?");

    expect(res.intent).toBe("SCENARIO");
    expect(res.answer).toMatch(/Scenario \(projected, nothing was changed\)/);
    expect(res.answer).toContain("₹33,000");
    expect(res.answer).toContain("₹28,000");
    expect(res.answer).toContain("₹60,000");
    expect(res.verification.passed).toBe(true);
    expect(res.tools.find((t) => t.tool === "calculateScenario")?.basis).toBe("PROJECTED");
    expect(Object.keys(tools).some((k) => /^(set|update|create|delete|save)/.test(k))).toBe(false);
  });

  it("asks for an amount instead of guessing when the scenario has none", async () => {
    const tools = makeTools();
    tools.calculateScenario.mockResolvedValue(null);
    const res = await new FinancialEngineService(tools as never).ask("user-1", "What happens if I increase my SIP?");
    expect(res.answer).toMatch(/need a specific amount/);
  });

  it("answers net worth from the facts tool (not from RAG text)", async () => {
    const tools = makeTools();
    const res = await new FinancialEngineService(tools as never).ask("user-1", "What is my current net worth?");
    expect(tools.getNetWorth).toHaveBeenCalledWith("user-1");
    expect(res.answer).toContain("₹1,40,000");
    expect(res.verification.passed).toBe(true);
  });

  it("hands document questions to RAG without calling any financial tool or inventing renewal details", async () => {
    const tools = makeTools();
    const res = await new FinancialEngineService(tools as never).ask("user-1", "What does my insurance policy say about renewal?");
    expect(res.handled).toBe(false);
    expect(res.handoff?.to).toBe("RAG_SEARCH");
    expect(res.answer).toBeNull();
    expect(tools.getCashFlow).not.toHaveBeenCalled();
    expect(tools.getNetWorth).not.toHaveBeenCalled();
  });

  it("hands unsupported scenarios to Scenario Studio and education to general education", async () => {
    const svc = new FinancialEngineService(makeTools() as never);
    expect((await svc.ask("u", "what if I prepay my home loan by ₹2 lakh")).handoff?.to).toBe("SCENARIO_STUDIO");
    expect((await svc.ask("u", "explain what an index fund is")).handoff?.to).toBe("GENERAL_EDUCATION");
  });

  it("never returns an unverified figure: inconsistent facts trigger the raw-facts fallback", async () => {
    const tools = makeTools();
    const bad = position();
    bad.facts.totalCash = money("99999.00");
    tools.getNetWorth.mockResolvedValue(bad);
    const res = await new FinancialEngineService(tools as never).ask("user-1", "What is my current net worth?");
    expect(res.usedFallback).toBe(true);
    expect(res.answer).toMatch(/couldn't present this reliably/);
  });

  it("reports when the data-health scan could not run instead of hiding it", async () => {
    const tools = makeTools();
    tools.getDataHealth.mockRejectedValue(new Error("db"));
    const res = await new FinancialEngineService(tools as never).ask("user-1", "How much did I invest this month?");
    expect(res.answer).toMatch(/data-health check/);
  });
});
