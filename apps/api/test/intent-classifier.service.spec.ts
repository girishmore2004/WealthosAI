import { IntentClassifierService } from "../src/ai/coach/planning/intent-classifier.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

describe("IntentClassifierService.classify", () => {
  it("takes the deterministic path without calling the gateway when a known intent matches", async () => {
    const mockGateway = { classify: jest.fn() };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify("user-1", "What's my net worth?");

    expect(result.path).toBe("deterministic");
    if (result.path === "deterministic") {
      expect(result.intent.id).toBe("NET_WORTH");
    }
    expect(mockGateway.classify).not.toHaveBeenCalled();
  });

  it("calls the gateway to classify an advanced intent when nothing deterministic matches", async () => {
    const mockGateway = {
      classify: jest.fn().mockResolvedValue({ data: { label: "goal_conflict" }, confidence: 0.82 }),
    };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify("user-1", "Can I actually afford all these goals I've set?");

    expect(result.path).toBe("advanced");
    if (result.path === "advanced") {
      expect(result.intent).toBe("goal_conflict");
      expect(result.confidence).toBe(0.82);
    }
    expect(mockGateway.classify).toHaveBeenCalledTimes(1);
  });

  it("falls back to general_search with zero confidence when the gateway is unavailable", async () => {
    const mockGateway = { classify: jest.fn().mockRejectedValue(new AiUnavailableException("no key configured")) };
    const service = new IntentClassifierService(mockGateway as never);

    const result = await service.classify("user-1", "some unrecognized question about my finances");

    expect(result.path).toBe("advanced");
    if (result.path === "advanced") {
      expect(result.intent).toBe("general_search");
      expect(result.confidence).toBe(0);
    }
  });
});
