import { CriticAgentService } from "../src/ai/coach/verification/critic-agent.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

function makeCritic(gatewayOverrides: object = {}) {
  const defaultGateway = { classify: jest.fn().mockResolvedValue({ data: { label: "safe" }, confidence: 0.9 }) };
  return new CriticAgentService({ ...defaultGateway, ...gatewayOverrides } as never);
}

describe("CriticAgentService", () => {
  it("flags overpromising language heuristically even without calling the gateway", async () => {
    const gateway = { classify: jest.fn().mockResolvedValue({ data: { label: "safe" }, confidence: 0.9 }) };
    const critic = makeCritic(gateway);

    const result = await critic.critique("user-1", "This investment is guaranteed and risk-free, you can't lose.");

    expect(result.flags).toContain("OVERPROMISING");
    expect(result.severity).toBe("medium");
  });

  it("flags unsafe advice heuristically at high severity", async () => {
    const critic = makeCritic();
    const result = await critic.critique("user-1", "You should consider borrowing against your retirement fund to cover this.");

    expect(result.flags).toContain("UNSAFE_ADVICE");
    expect(result.severity).toBe("high");
  });

  it("returns 'none' severity for a clean answer", async () => {
    const critic = makeCritic();
    const result = await critic.critique("user-1", "Your monthly surplus is ₹25,000 based on your current income and expenses.");

    expect(result.flags).toEqual([]);
    expect(result.severity).toBe("none");
  });

  it("incorporates the LLM classification result when it flags something the heuristics missed", async () => {
    const gateway = { classify: jest.fn().mockResolvedValue({ data: { label: "needs_disclaimer" }, confidence: 0.7 }) };
    const critic = makeCritic(gateway);

    const result = await critic.critique("user-1", "A perfectly plain-sounding sentence.");

    expect(result.flags).toContain("NEEDS_DISCLAIMER");
    expect(result.severity).toBe("medium");
  });

  it("degrades to heuristic-only result when the gateway is unavailable, without throwing", async () => {
    const gateway = { classify: jest.fn().mockRejectedValue(new AiUnavailableException("down")) };
    const critic = makeCritic(gateway);

    const result = await critic.critique("user-1", "A perfectly plain-sounding sentence.");

    expect(result.severity).toBe("none");
  });
});
