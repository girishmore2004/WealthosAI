import { Test } from "@nestjs/testing";
import { ModelRouterService } from "../src/ai/gateway/model-router.service";
import { ModelRoutingStatsService } from "../src/ai/gateway/model-routing-stats.service";

const CONFIG_VALUES: Record<string, unknown> = {
  "ai.smallModel": "small",
  "ai.largeModel": "large",
  "ai.fallbackModel": "fallback",
  "ai.modelPricing": {
    small: { promptPer1M: 0.05, completionPer1M: 0.08 },
    large: { promptPer1M: 1.0, completionPer1M: 2.0 },
  },
};

describe("ModelRouterService", () => {
  let router: ModelRouterService;
  let stats: ModelRoutingStatsService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelRouterService,
        ModelRoutingStatsService,
        {
          provide: require("@nestjs/config").ConfigService,
          useValue: { get: jest.fn((key: string) => CONFIG_VALUES[key]) },
        },
      ],
    }).compile();

    router = moduleRef.get(ModelRouterService);
    stats = moduleRef.get(ModelRoutingStatsService);
  });

  it("defaults classification/extraction/ranking to the small model", () => {
    for (const taskType of ["classification", "extraction", "ranking"] as const) {
      const decision = router.resolveChain(taskType, "short input", {});
      expect(decision.model).toBe("small");
      expect(decision.reason).toBe("task_default");
    }
  });

  it("defaults generation/summarization to the large model", () => {
    for (const taskType of ["generation", "summarization"] as const) {
      const decision = router.resolveChain(taskType, "short input", {});
      expect(decision.model).toBe("large");
      expect(decision.reason).toBe("task_default");
    }
  });

  it("upgrades a long/complex classification input to the large model", () => {
    const longInput = "x".repeat(3500);
    const decision = router.resolveChain("classification", longInput, {});
    expect(decision.model).toBe("large");
    expect(decision.reason).toBe("complexity_upgrade");
  });

  it("downgrades a low-complexity generation call via explicit complexityHint", () => {
    const decision = router.resolveChain("generation", "short", { complexityHint: "low" });
    expect(decision.model).toBe("small");
    expect(decision.reason).toBe("complexity_downgrade");
  });

  it("produces a de-duplicated 3-candidate fallback chain by default", () => {
    const decision = router.resolveChain("generation", "hello", {});
    expect(decision.chain).toEqual(["large", "small", "fallback"]);
  });

  it("falls back to the small model as the last chain entry when no fallbackModel is configured", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelRouterService,
        ModelRoutingStatsService,
        {
          provide: require("@nestjs/config").ConfigService,
          useValue: { get: jest.fn((key: string) => (key === "ai.fallbackModel" ? "" : CONFIG_VALUES[key])) },
        },
      ],
    }).compile();
    const routerWithoutFallback = moduleRef.get(ModelRouterService);

    const decision = routerWithoutFallback.resolveChain("generation", "hello", {});
    expect(decision.chain).toEqual(["large", "small"]); // deduplicated, no empty entry
  });

  it("downgrades to the small model on an accuracy signal once both models have enough samples", () => {
    // Give "large" a materially worse recent failure rate than "small" for this task
    // type, both past MIN_SAMPLE_SIZE.
    for (let i = 0; i < 25; i++) {
      stats.record("large", "generation", i < 10 ? "OK" : "MALFORMED_FALLBACK", 500); // 60% failure
      stats.record("small", "generation", "OK", 400); // 0% failure
    }

    const decision = router.resolveChain("generation", "hello", {});
    expect(decision.model).toBe("small");
    expect(decision.reason).toBe("accuracy_downgrade");
  });

  it("does not apply the accuracy signal until both candidates have at least MIN_SAMPLE_SIZE samples", () => {
    for (let i = 0; i < 5; i++) {
      stats.record("large", "generation", "ERROR", 500);
      stats.record("small", "generation", "OK", 400);
    }

    const decision = router.resolveChain("generation", "hello", {});
    expect(decision.model).toBe("large"); // still the task default — not enough samples to trust the comparison
    expect(decision.reason).toBe("task_default");
  });

  it("downgrades to the small model when the large model's recent p95 latency exceeds the caller's maxLatencyMs", () => {
    for (let i = 0; i < 25; i++) {
      stats.record("large", "generation", "OK", 5000);
      stats.record("small", "generation", "OK", 300);
    }

    const decision = router.resolveChain("generation", "hello", { maxLatencyMs: 1000 });
    expect(decision.model).toBe("small");
    expect(decision.reason).toBe("latency_downgrade");
  });

  it("downgrades to the small model when the large model's rough cost would exceed maxCostUsd", () => {
    const decision = router.resolveChain("generation", "x".repeat(400), { maxCostUsd: 0.0000001 });
    expect(decision.model).toBe("small");
    expect(decision.reason).toBe("budget_downgrade");
  });
});
