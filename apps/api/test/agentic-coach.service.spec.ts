import { AgenticCoachService } from "../src/ai/coach/agentic-coach.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

function makeService(overrides: {
  coach?: object;
  classifier?: object;
  planner?: object;
  gatherer?: object;
  composer?: object;
  verifierAgent?: object;
  critic?: object;
  memory?: object;
  financialMemory?: object;
  calculator?: object;
  planAgent?: object;
  taskAgent?: object;
  planMonitor?: object;
  gateway?: object;
  orchestrator?: object;
}) {
  const defaultMemory = { checkForStaleOrRepeatedAdvice: jest.fn().mockResolvedValue(null), recordRun: jest.fn().mockResolvedValue(undefined) };
  const defaultCritic = { critique: jest.fn().mockResolvedValue({ flags: [], severity: "none", guidance: "" }) };
  const defaultVerifierAgent = { verify: jest.fn().mockReturnValue({ passed: true, unmatchedNumbers: [] }) };
  const defaultFinancialMemory = { summarizeForPrompt: jest.fn().mockResolvedValue(""), addConstraint: jest.fn(), setPreference: jest.fn(), setGoalNote: jest.fn() };

  return new AgenticCoachService(
    (overrides.coach ?? {}) as never,
    (overrides.classifier ?? {}) as never,
    (overrides.planner ?? {}) as never,
    (overrides.gatherer ?? {}) as never,
    (overrides.composer ?? {}) as never,
    (overrides.verifierAgent ?? defaultVerifierAgent) as never,
    (overrides.critic ?? defaultCritic) as never,
    (overrides.memory ?? defaultMemory) as never,
    (overrides.financialMemory ?? defaultFinancialMemory) as never,
    (overrides.calculator ?? {}) as never,
    (overrides.planAgent ?? {}) as never,
    (overrides.taskAgent ?? {}) as never,
    (overrides.planMonitor ?? {}) as never,
    (overrides.gateway ?? {}) as never,
    overrides.orchestrator as never,
  );
}

describe("AgenticCoachService.ask — deterministic path", () => {
  it("composes an explanation around the base v1 answer when composition succeeds", async () => {
    const memory = { checkForStaleOrRepeatedAdvice: jest.fn().mockResolvedValue(null), recordRun: jest.fn().mockResolvedValue(undefined) };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "deterministic", intent: { id: "NET_WORTH", topicLabel: "net worth", patterns: [] } }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "step 1" }], needsVerification: false, needsComposition: true }) },
      coach: { ask: jest.fn().mockResolvedValue({ answer: "Net worth is X.", dataSources: ["income", "loans"] }) },
      composer: { compose: jest.fn().mockResolvedValue({ answer: "Your net worth is X, which is healthy.", confidence: 0.9 }) },
      memory,
    });

    const result = await service.ask("user-1", "What's my net worth?");

    expect(result.path).toBe("DETERMINISTIC");
    expect(result.matchedIntent).toBe("NET_WORTH");
    expect(result.answer).toBe("Your net worth is X, which is healthy.");
    expect(result.verificationPassed).toBe(true);
    expect(result.planId).toBeNull();
    expect(result.createdTaskIds).toEqual([]);
    expect(memory.recordRun).toHaveBeenCalledTimes(1);
  });

  it("falls back to the base v1 answer verbatim when composition is unavailable", async () => {
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "deterministic", intent: { id: "NET_WORTH", topicLabel: "net worth", patterns: [] } }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "step 1" }], needsVerification: false, needsComposition: true }) },
      coach: { ask: jest.fn().mockResolvedValue({ answer: "Net worth is X.", dataSources: ["income"] }) },
      composer: { compose: jest.fn().mockRejectedValue(new AiUnavailableException("down")) },
    });

    const result = await service.ask("user-1", "What's my net worth?");

    expect(result.answer).toBe("Net worth is X.");
    expect(result.confidence).toBe(1);
  });

  it("falls back to the base v1 answer when the Critic Agent flags the composed color-text", async () => {
    const critic = { critique: jest.fn().mockResolvedValue({ flags: ["OVERPROMISING"], severity: "medium", guidance: "rewrite without guarantees" }) };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "deterministic", intent: { id: "NET_WORTH", topicLabel: "net worth", patterns: [] } }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "step 1" }], needsVerification: false, needsComposition: true }) },
      coach: { ask: jest.fn().mockResolvedValue({ answer: "Net worth is X.", dataSources: ["income"] }) },
      composer: { compose: jest.fn().mockResolvedValue({ answer: "Your net worth is guaranteed to grow!", confidence: 0.9 }) },
      critic,
    });

    const result = await service.ask("user-1", "What's my net worth?");

    expect(result.answer).toBe("Net worth is X.");
    expect(result.criticFlags).toEqual(["OVERPROMISING"]);
  });
});

describe("AgenticCoachService.ask — legacy advanced path", () => {
  it("returns the RAG answer directly for general_search without a separate composition step", async () => {
    const gatherer = {
      gather: jest.fn().mockResolvedValue({
        factsText: "facts",
        facts: { hasEvidence: true },
        citedSources: ["chunk-1"],
        ragResult: { answer: "Found it in your documents.", answerConfidence: 0.75, retrievalConfidence: 0.8, citedSources: [] },
      }),
    };
    const composer = { compose: jest.fn() };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "general_search", confidence: 0 }) },
      planner: {
        buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "search" }], needsVerification: false, needsComposition: false }),
      },
      gatherer,
      composer,
    });

    const result = await service.ask("user-1", "some general question");

    expect(result.answer).toBe("Found it in your documents.");
    expect(result.confidence).toBe(0.75);
    expect(composer.compose).not.toHaveBeenCalled();
    expect(result.citedSources).toEqual(["chunk-1"]);
  });

  it("falls back to the raw facts when the composed answer fails numeric verification even after one refine attempt", async () => {
    const gatherer = {
      gather: jest.fn().mockResolvedValue({ factsText: "surplus is 5000", facts: { surplus: 5000 }, citedSources: [] }),
    };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "You have a surplus of 9999, plenty of room.", confidence: 0.8 }) };
    const verifierAgent = { verify: jest.fn().mockReturnValue({ passed: false, unmatchedNumbers: ["9999"] }) };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "goal_conflict", confidence: 0.9 }) },
      planner: {
        buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "gather" }], needsVerification: true, needsComposition: true }),
      },
      gatherer,
      composer,
      verifierAgent,
    });

    const result = await service.ask("user-1", "can I afford my goals");

    expect(result.answer).toBe("surplus is 5000"); // fell back to factsText, not the unverified composed answer
    expect(result.verificationPassed).toBe(false);
    expect(result.confidence).toBe(0.5);
    expect(composer.compose).toHaveBeenCalledTimes(2); // one refine attempt before falling back
  });

  it("recovers via the refine retry when the Critic Agent flags the first composition but the retry is clean", async () => {
    const gatherer = {
      gather: jest.fn().mockResolvedValue({ factsText: "surplus is 5000", facts: { surplus: 5000 }, citedSources: [] }),
    };
    const composer = {
      compose: jest
        .fn()
        .mockResolvedValueOnce({ answer: "Your surplus is guaranteed to grow, 5000 risk-free.", confidence: 0.8 })
        .mockResolvedValueOnce({ answer: "Your surplus is 5000.", confidence: 0.85 }),
    };
    const critic = {
      critique: jest
        .fn()
        .mockResolvedValueOnce({ flags: ["OVERPROMISING"], severity: "medium", guidance: "remove guarantee language" })
        .mockResolvedValueOnce({ flags: [], severity: "none", guidance: "" }),
    };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "goal_conflict", confidence: 0.9 }) },
      planner: {
        buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "gather" }], needsVerification: true, needsComposition: true }),
      },
      gatherer,
      composer,
      critic,
    });

    const result = await service.ask("user-1", "can I afford my goals");

    expect(result.answer).toBe("Your surplus is 5000.");
    expect(result.verificationPassed).toBe(true);
    expect(result.criticFlags).toEqual([]);
  });

  it("includes a stale-advice note from the memory service when one is returned", async () => {
    const memory = {
      checkForStaleOrRepeatedAdvice: jest.fn().mockResolvedValue("Your data has changed since yesterday."),
      recordRun: jest.fn().mockResolvedValue(undefined),
    };
    const gatherer = {
      gather: jest.fn().mockResolvedValue({
        factsText: "facts",
        facts: {},
        citedSources: [],
        ragResult: { answer: "answer", answerConfidence: 0.6, retrievalConfidence: 0.6, citedSources: [] },
      }),
    };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "general_search", confidence: 0 }) },
      planner: {
        buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "search" }], needsVerification: false, needsComposition: false }),
      },
      gatherer,
      memory,
    });

    const result = await service.ask("user-1", "question");
    expect(result.staleAdviceNote).toBe("Your data has changed since yesterday.");
  });
});

describe("AgenticCoachService.ask — create_plan", () => {
  it("PROPOSES a plan for confirmation and does not create a CoachPlan or tasks from chat", async () => {
    const gatherer = {
      gatherGoalConflict: jest.fn().mockResolvedValue({ factsText: "income 100000, expenses 60000", facts: { surplus: 40000 }, citedSources: [] }),
      findLoanByHint: jest.fn().mockResolvedValue({
        match: { id: "loan-1", lender: "HDFC", type: "CAR", outstandingPrincipal: 300000, emiAmount: 15000, interestRateAnnual: 9 },
        candidates: [{ id: "loan-1", lender: "HDFC", type: "CAR" }],
      }),
    };
    const gateway = {
      extract: jest.fn().mockResolvedValue({
        data: { type: "DEBT_PAYOFF", title: "Pay off HDFC car loan", months: 18, loanNameHint: "HDFC" },
        confidence: 0.9,
      }),
    };
    const calculator = {
      loanPayoffWithExtraMonthly: jest.fn().mockResolvedValue({ monthsToPayoff: 20, interestSaved: 0, monthsSaved: 0, projectedPayoffDate: "2028-01-01" }),
      formatPayoffFacts: jest.fn().mockReturnValue("payoff facts"),
    };
    const planAgent = {
      createPlan: jest.fn().mockResolvedValue({
        planId: "plan-1",
        steps: [{ sequence: 1, description: "checkpoint 1", dueDate: new Date("2027-01-01") }],
      }),
    };
    const taskAgent = { createInitialTasksFromPlan: jest.fn().mockResolvedValue(["task-1"]) };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "Plan created: pay off your HDFC car loan.", confidence: 0.85 }) };

    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "create_plan", confidence: 0.9 }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "plan" }], needsVerification: true, needsComposition: true }) },
      gatherer,
      gateway,
      calculator,
      planAgent,
      taskAgent,
      composer,
    });

    const result = await service.ask("user-1", "help me pay off my HDFC car loan in 18 months");

    // Nothing is persisted from a chat message.
    expect(planAgent.createPlan).not.toHaveBeenCalled();
    expect(taskAgent.createInitialTasksFromPlan).not.toHaveBeenCalled();
    expect(result.planId).toBeNull();
    expect(result.createdTaskIds).toEqual([]);
    expect(result.answer).toBe("Plan created: pay off your HDFC car loan.");

    // The confirmable action carries the exact POST /coach/v2/plans body and a preview.
    const action = result.report?.executionActions.find((a) => a.kind === "CREATE_PLAN");
    expect(action).toBeDefined();
    expect(action?.requiresConfirmation).toBe(true);
    expect(action?.payload).toEqual(
      expect.objectContaining({ type: "DEBT_PAYOFF", targetMetricType: "loan_outstanding_principal", targetValue: 0, startingValue: 300000, linkedLoanId: "loan-1" }),
    );
    expect(action?.preview?.changes.length).toBeGreaterThan(0);
  });

  it("asks for clarification instead of guessing when the loan hint is ambiguous", async () => {
    const gatherer = {
      gatherGoalConflict: jest.fn().mockResolvedValue({ factsText: "facts", facts: {}, citedSources: [] }),
      findLoanByHint: jest.fn().mockResolvedValue({
        match: null,
        candidates: [
          { id: "loan-1", lender: "HDFC", type: "CAR" },
          { id: "loan-2", lender: "SBI", type: "HOME" },
        ],
      }),
    };
    const gateway = {
      extract: jest.fn().mockResolvedValue({ data: { type: "DEBT_PAYOFF", title: "Pay off a loan", months: 12 }, confidence: 0.7 }),
    };
    const planAgent = { createPlan: jest.fn() };

    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "create_plan", confidence: 0.9 }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "plan" }], needsVerification: true, needsComposition: true }) },
      gatherer,
      gateway,
      planAgent,
    });

    const result = await service.ask("user-1", "help me pay off my loan");

    expect(planAgent.createPlan).not.toHaveBeenCalled();
    expect(result.answer).toMatch(/please specify which one/);
    expect(result.planId).toBeNull();
  });
});

describe("AgenticCoachService.ask — plan_progress_check", () => {
  it("reports an honest 'no active plans' answer without needing composition when there are none", async () => {
    const planAgent = { listPlans: jest.fn().mockResolvedValue([]) };
    const composer = { compose: jest.fn() };

    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "plan_progress_check", confidence: 0.9 }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "check" }], needsVerification: true, needsComposition: true }) },
      planAgent,
      composer,
    });

    const result = await service.ask("user-1", "how's my plan going");

    expect(composer.compose).not.toHaveBeenCalled();
    expect(result.answer).toMatch(/don't have any active plans/);
  });

  it("checks every ACTIVE/AT_RISK plan and composes a combined status update", async () => {
    const planAgent = {
      listPlans: jest.fn().mockResolvedValue([
        { id: "plan-1", title: "Car loan payoff", status: "ACTIVE", targetValue: 0, targetDate: new Date("2028-01-01") },
      ]),
    };
    const planMonitor = {
      checkPlan: jest.fn().mockResolvedValue({
        planId: "plan-1",
        currentValue: 250000,
        expectedValue: 260000,
        onTrack: true,
        note: "On track.",
        status: "ACTIVE",
        nudgeCreated: false,
        createdTaskId: null,
      }),
    };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "You're on track on your car loan payoff.", confidence: 0.85 }) };

    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "plan_progress_check", confidence: 0.9 }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "check" }], needsVerification: true, needsComposition: true }) },
      planAgent,
      planMonitor,
      composer,
    });

    const result = await service.ask("user-1", "how's my plan going");

    expect(planMonitor.checkPlan).toHaveBeenCalledWith("user-1", "plan-1", "USER_QUERY");
    expect(result.answer).toBe("You're on track on your car loan payoff.");
    expect(result.planId).toBe("plan-1");
  });
});

describe("AgenticCoachService.ask — calculation_request", () => {
  it("computes a hypothetical EMI deterministically and composes an explanation from it", async () => {
    const gateway = {
      extract: jest.fn().mockResolvedValue({
        data: { operation: "hypothetical_emi", principal: 500000, annualRatePercent: 9, tenureMonths: 60 },
        confidence: 0.9,
      }),
    };
    const calculator = {
      emiForHypotheticalLoan: jest.fn().mockReturnValue({ emi: 10379.24, totalPayable: 622754.4, totalInterest: 122754.4 }),
      formatEmiFacts: jest.fn().mockReturnValue("EMI facts"),
    };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "Your EMI would be ₹10,379.24/month.", confidence: 0.85 }) };

    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "calculation_request", confidence: 0.9 }) },
      planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "calculate" }], needsVerification: true, needsComposition: true }) },
      gateway,
      calculator,
      composer,
    });

    const result = await service.ask("user-1", "what would my EMI be for 5 lakh at 9% over 5 years");

    expect(calculator.emiForHypotheticalLoan).toHaveBeenCalledWith(500000, 9, 60);
    expect(result.answer).toBe("Your EMI would be ₹10,379.24/month.");
    expect(result.planId).toBeNull();
  });
});

describe("AgenticCoachService.ask — native orchestration", () => {
  const report = {
    directAnswer: "Your savings rate for 2026-09 is 25%.",
    answerType: "fact",
    evidenceSufficiency: "sufficient",
    keyFindings: [],
    financialSnapshot: { asOf: "2026-10-15T00:00:00.000Z", currency: "INR", items: [] },
    evidenceCards: [],
    calculations: [],
    predictions: [],
    scenarioComparison: null,
    recommendations: [],
    actionPlan: [],
    charts: [],
    assumptions: [],
    risks: [],
    dataGaps: [],
    followUpSuggestions: [],
    executionActions: [],
    citations: [],
    metadata: { version: 1, generatedAt: "2026-10-15T00:00:00.000Z", engines: [], partial: false, explanationSource: "deterministic", executionMs: 5 },
  };

  it("uses the orchestrator result, never calls the legacy classifier, and keeps the deterministic answer when wording is unavailable", async () => {
    const orchestrator = { tryHandle: jest.fn().mockResolvedValue({ report, facts: { kind: "savings_rate" }, explanationFacts: "ANSWER: 25%", citedSources: [], confidence: 0.95, kind: "savings_rate" }) };
    const classifier = { classify: jest.fn() };
    const composer = { compose: jest.fn().mockRejectedValue(new AiUnavailableException("down")) };
    const memory = { checkForStaleOrRepeatedAdvice: jest.fn().mockResolvedValue(null), recordRun: jest.fn().mockResolvedValue(undefined) };
    const service = makeService({ orchestrator, classifier, composer, memory });

    const result = await service.ask("user-1", "What is my savings rate?");

    expect(orchestrator.tryHandle).toHaveBeenCalledWith("user-1", "What is my savings rate?");
    expect(classifier.classify).not.toHaveBeenCalled();
    expect(result.answer).toBe(report.directAnswer);
    expect(result.report?.metadata.explanationSource).toBe("deterministic");
    expect(result.report?.metadata.engines.some((e) => e.name === "explanation" && e.status === "unavailable")).toBe(true);
    // The structured report is stored with the run inside the existing facts column.
    expect(memory.recordRun).toHaveBeenCalledWith(expect.objectContaining({ facts: expect.objectContaining({ kind: "savings_rate", __report: expect.any(Object) }) }));
  });

  it("adds a model explanation only when it passes numeric verification", async () => {
    const orchestrator = { tryHandle: jest.fn().mockResolvedValue({ report, facts: { kind: "savings_rate" }, explanationFacts: "ANSWER: 25%", citedSources: [], confidence: 0.95, kind: "savings_rate" }) };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "That means you keep a quarter of what you earn.", confidence: 0.8 }) };
    const service = makeService({ orchestrator, composer });
    const result = await service.ask("user-1", "What is my savings rate?");
    expect(result.report?.explanation).toBe("That means you keep a quarter of what you earn.");
    expect(result.report?.metadata.explanationSource).toBe("model");
    expect(result.answer).toContain(report.directAnswer);
  });

  it("drops a model explanation that introduces an unverified number", async () => {
    const orchestrator = { tryHandle: jest.fn().mockResolvedValue({ report, facts: { kind: "savings_rate" }, explanationFacts: "ANSWER: 25%", citedSources: [], confidence: 0.95, kind: "savings_rate" }) };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "You save 40%.", confidence: 0.8 }) };
    const verifierAgent = { verify: jest.fn().mockReturnValue({ passed: false, unmatchedNumbers: ["40"] }) };
    const service = makeService({ orchestrator, composer, verifierAgent });
    const result = await service.ask("user-1", "What is my savings rate?");
    expect(result.report?.explanation).toBeUndefined();
    expect(result.answer).toBe(report.directAnswer);
  });

  it("falls through to the existing pipeline when the orchestrator defers or throws, and attaches a minimal report", async () => {
    for (const orchestrator of [{ tryHandle: jest.fn().mockResolvedValue(null) }, { tryHandle: jest.fn().mockRejectedValue(new Error("boom")) }]) {
      const coach = { ask: jest.fn().mockResolvedValue({ answer: "Base answer", dataSources: ["x"] }) };
      const composer = { compose: jest.fn().mockResolvedValue({ answer: "Base answer with context", confidence: 0.9 }) };
      const service = makeService({
        orchestrator,
        coach,
        composer,
        classifier: { classify: jest.fn().mockResolvedValue({ path: "deterministic", intent: { id: "summary" }, confidence: 1 }) },
        planner: { buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "s" }] }) },
      });
      const result = await service.ask("user-1", "Give me a summary");
      expect(coach.ask).toHaveBeenCalled();
      expect(result.report?.answerType).toBe("legacy");
      expect(result.report?.directAnswer).toBe(result.answer.slice(0, 4000));
    }
  });
});
