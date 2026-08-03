import { Test } from "@nestjs/testing";
import { AiGatewayService } from "../src/ai/gateway/ai-gateway.service";
import { GroqClient } from "../src/ai/groq/groq.client";
import { ModelRouterService } from "../src/ai/gateway/model-router.service";
import { ModelRoutingStatsService } from "../src/ai/gateway/model-routing-stats.service";
import { TokenAccountingService } from "../src/ai/gateway/token-accounting.service";
import { GroundingService } from "../src/ai/gateway/grounding.service";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { TokenBudgetService } from "../src/ai/gateway/token-budget.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";
import { PromptRegistryService } from "../src/ai/ops/prompt-registry.service";
import { AiLoggingService } from "../src/ai/ops/ai-logging.service";
import { AiCacheService } from "../src/ai/ops/ai-cache.service";
import { AiGroundingException, AiUnavailableException, AiValidationException } from "../src/ai/exceptions/ai.exceptions";

const CONFIG_VALUES: Record<string, unknown> = {
  "ai.smallModel": "test-small-model",
  "ai.largeModel": "test-large-model",
  "ai.fallbackModel": "test-fallback-model",
  "ai.semanticCacheThreshold": 0.94,
  "ai.modelPricing": {
    "test-small-model": { promptPer1M: 0.05, completionPer1M: 0.08 },
    "test-large-model": { promptPer1M: 0.59, completionPer1M: 0.79 },
    "test-fallback-model": { promptPer1M: 0.05, completionPer1M: 0.08 },
  },
};

describe("AiGatewayService", () => {
  let service: AiGatewayService;
  const mockGroq = { chat: jest.fn() };
  const mockPrompts = {
    getActive: jest.fn().mockResolvedValue({ name: "test.prompt", version: 1, template: "You are a test classifier." }),
  };
  const mockLogging = { log: jest.fn() };
  const mockCache = { get: jest.fn(), set: jest.fn(), getSemantic: jest.fn(), setSemantic: jest.fn() };
  const mockConfig = { get: jest.fn((key: string) => CONFIG_VALUES[key]) };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCache.get.mockResolvedValue(null);
    mockCache.getSemantic.mockResolvedValue(null);
    mockCache.set.mockResolvedValue(undefined);
    mockCache.setSemantic.mockResolvedValue(undefined);
    mockConfig.get.mockImplementation((key: string) => CONFIG_VALUES[key]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiGatewayService,
        { provide: GroqClient, useValue: mockGroq },
        ModelRouterService,
        ModelRoutingStatsService,
        TokenAccountingService,
        GroundingService,
        SchemaValidatorService,
        TokenBudgetService,
        RedactionService,
        { provide: PromptRegistryService, useValue: mockPrompts },
        { provide: AiLoggingService, useValue: mockLogging },
        { provide: AiCacheService, useValue: mockCache },
        { provide: require("@nestjs/config").ConfigService, useValue: mockConfig },
      ],
    }).compile();

    service = moduleRef.get(AiGatewayService);
  });

  describe("core pipeline (schema validation, caching, transport errors)", () => {
    it("returns a validated result on the first attempt when the model responds correctly", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.95 }),
        model: "test-small-model",
        promptTokens: 10,
        completionTokens: 5,
      });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.data.label).toBe("ping");
      expect(result.confidence).toBe(0.95);
      expect(result.meta.retries).toBe(0);
      expect(mockGroq.chat).toHaveBeenCalledTimes(1);
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ status: "OK", retries: 0 }));
    });

    it("retries with a correction message after malformed output, then succeeds", async () => {
      mockGroq.chat
        .mockResolvedValueOnce({ content: "not valid json", model: "test-small-model", promptTokens: 0, completionTokens: 0 })
        .mockResolvedValueOnce({
          content: JSON.stringify({ result: { label: "other" }, confidence: 0.7 }),
          model: "test-small-model",
          promptTokens: 0,
          completionTokens: 0,
        });

      const result = await service.classify("blah", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.data.label).toBe("other");
      expect(result.meta.retries).toBe(1);
      expect(mockGroq.chat).toHaveBeenCalledTimes(2);
      const secondCallMessages = mockGroq.chat.mock.calls[1][0].messages;
      expect(secondCallMessages.some((m: { content: string }) => m.content.includes("did not match the required shape"))).toBe(true);
    });

    it("throws AiValidationException after exhausting all correction attempts", async () => {
      mockGroq.chat.mockResolvedValue({ content: "still not json", model: "test-small-model", promptTokens: 0, completionTokens: 0 });

      await expect(
        service.classify("blah", ["ping", "other"], { feature: "test", promptName: "test.prompt" }),
      ).rejects.toThrow(AiValidationException);

      // 1 initial + 2 corrective retries, each of which walks the full 3-model
      // fallback chain (small/large/fallback are all set to the same always-failing
      // mock here) — see the "walks the full fallback chain" test below for a case
      // that isolates transport-failure fallback specifically.
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ status: "MALFORMED_FALLBACK" }));
    });

    it("returns a cached result without calling Groq when an exact cache entry exists", async () => {
      mockCache.get.mockResolvedValue({ result: { label: "ping" }, confidence: 0.99 });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.data.label).toBe("ping");
      expect(result.meta.cacheHit).toBe(true);
      expect(result.meta.cacheType).toBe("exact");
      expect(mockGroq.chat).not.toHaveBeenCalled();
    });

    it("logs status ERROR and rethrows AiUnavailableException as-is when every candidate model fails", async () => {
      const transportError = new AiUnavailableException("HTTP 503 from Groq");
      mockGroq.chat.mockRejectedValue(transportError);

      await expect(
        service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" }),
      ).rejects.toBe(transportError);

      // small/large/fallback are 3 distinct configured models here, so the chain has
      // 3 candidates — all must be tried and fail before the exception surfaces.
      expect(mockGroq.chat).toHaveBeenCalledTimes(3);
      expect(mockLogging.log).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ERROR", feature: "test", promptName: "test.prompt", fallbackUsed: false }),
      );
    });

    it("proceeds to call Groq when AiCacheService.get() throws, instead of failing the whole request", async () => {
      mockCache.get.mockRejectedValue(new Error("ECONNREFUSED: redis down"));
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
        model: "test-small-model",
        promptTokens: 10,
        completionTokens: 5,
      });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.data.label).toBe("ping");
      expect(mockGroq.chat).toHaveBeenCalledTimes(1);
    });
  });

  describe("dynamic model routing", () => {
    it("routes generation to the large model by default", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { text: "hello" }, confidence: 0.9 }),
        model: "test-large-model",
        promptTokens: 20,
        completionTokens: 10,
      });

      await service.generate("write something", { feature: "test", promptName: "test.prompt" });

      expect(mockGroq.chat.mock.calls[0][0].model).toBe("test-large-model");
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ routingReason: "task_default" }));
    });

    it("downgrades a low-complexity generation call to the small model", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { text: "ok" }, confidence: 0.9 }),
        model: "test-small-model",
        promptTokens: 5,
        completionTokens: 2,
      });

      await service.generate("hi", { feature: "test", promptName: "test.prompt", complexityHint: "low" });

      expect(mockGroq.chat.mock.calls[0][0].model).toBe("test-small-model");
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ routingReason: "complexity_downgrade" }));
    });

    it("upgrades a high-complexity classification call to the large model", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
        model: "test-large-model",
        promptTokens: 5,
        completionTokens: 2,
      });

      await service.classify("ping", ["ping", "other"], {
        feature: "test",
        promptName: "test.prompt",
        complexityHint: "high",
      });

      expect(mockGroq.chat.mock.calls[0][0].model).toBe("test-large-model");
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ routingReason: "complexity_upgrade" }));
    });

    it("walks the fallback chain when the first candidate model is unavailable, and reports fallbackUsed", async () => {
      mockGroq.chat
        .mockRejectedValueOnce(new AiUnavailableException("model A down"))
        .mockResolvedValueOnce({
          content: JSON.stringify({ result: { text: "recovered" }, confidence: 0.8 }),
          model: "test-fallback-model",
          promptTokens: 8,
          completionTokens: 4,
        });

      const result = await service.generate("write something", { feature: "test", promptName: "test.prompt" });

      expect(mockGroq.chat).toHaveBeenCalledTimes(2);
      expect(mockGroq.chat.mock.calls[0][0].model).toBe("test-large-model"); // generation's default
      expect(mockGroq.chat.mock.calls[1][0].model).toBe("test-small-model"); // next in chain
      expect(result.meta.fallbackUsed).toBe(true);
      expect(result.meta.model).toBe("test-small-model");
      expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ status: "OK", fallbackUsed: true }));
    });
  });

  describe("exact token accounting", () => {
    it("populates real prompt/completion/total tokens and estimated cost from Groq's usage, not an estimate", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
        model: "test-small-model",
        promptTokens: 123,
        completionTokens: 45,
      });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.meta.promptTokens).toBe(123);
      expect(result.meta.completionTokens).toBe(45);
      expect(result.meta.totalTokens).toBe(168);
      // (123/1e6)*0.05 + (45/1e6)*0.08 = 0.00000975
      expect(result.meta.estimatedCostUsd).toBeCloseTo(0.00000975, 8);
      expect(mockLogging.log).toHaveBeenCalledWith(
        expect.objectContaining({ promptTokens: 123, completionTokens: 45, estimatedCostUsd: expect.any(Number) }),
      );
    });

    it("returns a null cost (not $0) when the responding model isn't in the pricing table", async () => {
      mockConfig.get.mockImplementation((key: string) =>
        key === "ai.modelPricing" ? {} : CONFIG_VALUES[key],
      );
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
        model: "test-small-model",
        promptTokens: 10,
        completionTokens: 5,
      });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.meta.estimatedCostUsd).toBeNull();
    });

    it("logs zero tokens and zero cost on a cache hit", async () => {
      mockCache.get.mockResolvedValue({ result: { label: "ping" }, confidence: 0.99 });

      const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.meta.promptTokens).toBe(0);
      expect(result.meta.completionTokens).toBe(0);
      expect(result.meta.estimatedCostUsd).toBe(0);
    });
  });

  describe("semantic prompt cache", () => {
    it("serves a semantic cache hit when there is no exact match but a similar one is found", async () => {
      mockCache.get.mockResolvedValue(null);
      mockCache.getSemantic.mockResolvedValue({ value: { result: { label: "ping" }, confidence: 0.88 }, similarity: 0.97 });

      const result = await service.classify("ping please", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(result.data.label).toBe("ping");
      expect(result.meta.cacheType).toBe("semantic");
      expect(result.meta.cacheHit).toBe(true);
      expect(mockGroq.chat).not.toHaveBeenCalled();
    });

    it("does not consult the semantic cache for generation calls by default", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { text: "hi" }, confidence: 0.9 }),
        model: "test-large-model",
        promptTokens: 5,
        completionTokens: 2,
      });

      await service.generate("write something", { feature: "test", promptName: "test.prompt" });

      expect(mockCache.getSemantic).not.toHaveBeenCalled();
    });

    it("writes a fresh result to the semantic cache after a successful classification call", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
        model: "test-small-model",
        promptTokens: 5,
        completionTokens: 2,
      });

      await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

      expect(mockCache.setSemantic).toHaveBeenCalledWith("test", "test.prompt", 1, "ping", expect.any(Object));
    });
  });

  describe("grounding and hallucination detection", () => {
    it("computes a groundingScore and hallucinationRisk when groundingContext is supplied, without blocking the response by default", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { text: "Your portfolio grew by 45%" }, confidence: 0.9 }),
        model: "test-large-model",
        promptTokens: 20,
        completionTokens: 10,
      });

      const result = await service.generate("summarize my portfolio", {
        feature: "test",
        promptName: "test.prompt",
        groundingContext: "Portfolio value increased from 100 to 105 this month.",
      });

      expect(result.groundingScore).not.toBeNull();
      expect(result.hallucinationRisk).toBe("high"); // 45% appears nowhere in the given context
      expect(result.data.text).toContain("45%"); // not blocked — rejectOnLowGrounding was not set
    });

    it("retries with a correction and then throws AiGroundingException when rejectOnLowGrounding is set and the model keeps hallucinating", async () => {
      mockGroq.chat.mockResolvedValue({
        content: JSON.stringify({ result: { text: "Your portfolio grew by 45%" }, confidence: 0.9 }),
        model: "test-large-model",
        promptTokens: 20,
        completionTokens: 10,
      });

      await expect(
        service.generate("summarize my portfolio", {
          feature: "test",
          promptName: "test.prompt",
          groundingContext: "Portfolio value increased from 100 to 105 this month.",
          rejectOnLowGrounding: true,
        }),
      ).rejects.toThrow(AiGroundingException);

      expect(mockGroq.chat.mock.calls.length).toBeGreaterThan(1); // at least one corrective retry attempted
      const correctionMessages = mockGroq.chat.mock.calls[1][0].messages;
      expect(
        correctionMessages.some((m: { content: string }) => m.content.includes("figures not present in the given facts")),
      ).toBe(true);
    });

    it("succeeds once the model corrects itself on a grounding retry", async () => {
      mockGroq.chat
        .mockResolvedValueOnce({
          content: JSON.stringify({ result: { text: "Your portfolio grew by 45%" }, confidence: 0.9 }),
          model: "test-large-model",
          promptTokens: 20,
          completionTokens: 10,
        })
        .mockResolvedValueOnce({
          content: JSON.stringify({ result: { text: "Your portfolio grew from 100 to 105" }, confidence: 0.9 }),
          model: "test-large-model",
          promptTokens: 20,
          completionTokens: 10,
        });

      const result = await service.generate("summarize my portfolio", {
        feature: "test",
        promptName: "test.prompt",
        groundingContext: "Portfolio value increased from 100 to 105 this month.",
        rejectOnLowGrounding: true,
      });

      expect(result.hallucinationRisk).not.toBe("high");
      expect(result.data.text).toContain("100 to 105");
    });
  });
});
