import { AiGatewayService } from "../src/ai/gateway/ai-gateway.service";

// The breaker helpers are private; exercise them through the instance without booting Nest.
type Breaker = {
  modelCooldownUntil: Map<string, number>;
  isCoolingDown(m: string): boolean;
  markModelFailed(m: string, e: unknown): void;
};
const make = () => Object.create(AiGatewayService.prototype, {}) as unknown as Breaker;
const fresh = () => {
  const b = make();
  b.modelCooldownUntil = new Map();
  return b;
};

describe("AiGatewayService model circuit breaker", () => {
  it("does not skip a healthy model", () => {
    expect(fresh().isCoolingDown("m")).toBe(false);
  });

  it("skips a model for a short time after a transient failure", () => {
    const b = fresh();
    b.markModelFailed("m", new Error("HTTP 429 from Groq"));
    expect(b.isCoolingDown("m")).toBe(true);
    const until = b.modelCooldownUntil.get("m")!;
    expect(until - Date.now()).toBeLessThanOrEqual(60_000);
  });

  it("skips a decommissioned model (HTTP 400/404) for much longer", () => {
    const b = fresh();
    b.markModelFailed("m", new Error("HTTP 404 from Groq: model_not_found"));
    expect(b.modelCooldownUntil.get("m")! - Date.now()).toBeGreaterThan(10 * 60_000);
  });

  it("forgets the cooldown once it has expired", () => {
    const b = fresh();
    b.modelCooldownUntil.set("m", Date.now() - 1);
    expect(b.isCoolingDown("m")).toBe(false);
    expect(b.modelCooldownUntil.has("m")).toBe(false);
  });
});
