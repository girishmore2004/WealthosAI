import { AgenticCoachService } from "../src/ai/coach/agentic-coach.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

function makeService(overrides: {
  coach?: object;
  classifier?: object;
  planner?: object;
  gatherer?: object;
  composer?: object;
  verifier?: object;
  memory?: object;
}) {
  const defaultMemory = { checkForStaleOrRepeatedAdvice: jest.fn().mockResolvedValue(null), recordRun: jest.fn().mockResolvedValue(undefined) };
  return new AgenticCoachService(
    (overrides.coach ?? {}) as never,
    (overrides.classifier ?? {}) as never,
    (overrides.planner ?? {}) as never,
    (overrides.gatherer ?? {}) as never,
    (overrides.composer ?? {}) as never,
    (overrides.verifier ?? {}) as never,
    (overrides.memory ?? defaultMemory) as never,
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
});

describe("AgenticCoachService.ask — advanced path", () => {
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

  it("falls back to the raw facts when the composed answer fails numeric verification", async () => {
    const gatherer = {
      gather: jest.fn().mockResolvedValue({ factsText: "surplus is 5000", facts: { surplus: 5000 }, citedSources: [] }),
    };
    const composer = { compose: jest.fn().mockResolvedValue({ answer: "You have a surplus of 9999, plenty of room.", confidence: 0.8 }) };
    const verifier = { verify: jest.fn().mockReturnValue({ passed: false, unmatchedNumbers: ["9999"] }) };
    const service = makeService({
      classifier: { classify: jest.fn().mockResolvedValue({ path: "advanced", intent: "goal_conflict", confidence: 0.9 }) },
      planner: {
        buildPlan: jest.fn().mockReturnValue({ steps: [{ description: "gather" }], needsVerification: true, needsComposition: true }),
      },
      gatherer,
      composer,
      verifier,
    });

    const result = await service.ask("user-1", "can I afford my goals");

    expect(result.answer).toBe("surplus is 5000"); // fell back to factsText, not the unverified composed answer
    expect(result.verificationPassed).toBe(false);
    expect(result.confidence).toBe(0.5);
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
