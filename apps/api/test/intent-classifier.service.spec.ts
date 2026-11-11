
import { IntentClassifierService } from "../src/ai/coach/planning/intent-classifier.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

describe("IntentClassifierService.classify", () => {
  it("uses the deterministic path for a known intent", async () => {
    const mockGateway = { classify: jest.fn() };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify("user-1", "What's my net worth?");

    expect(result.path).toBe("deterministic");

    if (result.path === "deterministic") {
      expect(result.intent.id).toBe("NET_WORTH");
    }

    expect(mockGateway.classify).not.toHaveBeenCalled();
  });

  it("recognizes a prioritized financial improvement plan", async () => {
    const mockGateway = { classify: jest.fn() };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify(
      "user-1",
      "Create a prioritized financial improvement plan with measurable targets, timelines and expected outcomes.",
    );

    expect(result).toEqual({
      path: "advanced",
      intent: "prioritize_actions",
      confidence: 1,
    });

    expect(mockGateway.classify).not.toHaveBeenCalled();
  });

  it("recognizes the word prioritised", async () => {
    const mockGateway = { classify: jest.fn() };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify(
      "user-1",
      "Give me prioritised actions to improve my finances.",
    );

    expect(result.path).toBe("advanced");

    if (result.path === "advanced") {
      expect(result.intent).toBe("prioritize_actions");
    }

    expect(mockGateway.classify).not.toHaveBeenCalled();
  });

  it("recognizes a general financial improvement plan", async () => {
    const mockGateway = { classify: jest.fn() };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify(
      "user-1",
      "Create a financial improvement plan for me.",
    );

    expect(result.path).toBe("advanced");

    if (result.path === "advanced") {
      expect(result.intent).toBe("prioritize_actions");
    }

    expect(mockGateway.classify).not.toHaveBeenCalled();
  });

  it("uses the gateway for advanced goal-conflict questions", async () => {
    const mockGateway = {
      classify: jest.fn().mockResolvedValue({
        data: { label: "goal_conflict" },
        confidence: 0.82,
      }),
    };

    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify(
      "user-1",
      "Can I actually afford all these goals I've set?",
    );

    expect(result.path).toBe("advanced");

    if (result.path === "advanced") {
      expect(result.intent).toBe("goal_conflict");
      expect(result.confidence).toBe(0.82);
    }

    expect(mockGateway.classify).toHaveBeenCalledTimes(1);
  });

  it("falls back to general_search when the gateway is unavailable", async () => {
    const mockGateway = {
      classify: jest.fn().mockRejectedValue(
        new AiUnavailableException("no key configured"),
      ),
    };

    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify(
      "user-1",
      "some unrecognized question about my finances",
    );

    expect(result.path).toBe("advanced");

    if (result.path === "advanced") {
      expect(result.intent).toBe("general_search");
      expect(result.confidence).toBe(0);
    }
  });
});
