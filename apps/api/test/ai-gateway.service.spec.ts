import { Test } from "@nestjs/testing";
import { AiGatewayService } from "../src/ai/gateway/ai-gateway.service";
import { GroqClient } from "../src/ai/groq/groq.client";
import { ModelRouterService } from "../src/ai/gateway/model-router.service";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { TokenBudgetService } from "../src/ai/gateway/token-budget.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";
import { PromptRegistryService } from "../src/ai/ops/prompt-registry.service";
import { AiLoggingService } from "../src/ai/ops/ai-logging.service";
import { AiCacheService } from "../src/ai/ops/ai-cache.service";
import { AiValidationException, AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

describe("AiGatewayService.classify", () => {
  let service: AiGatewayService;
  const mockGroq = { chat: jest.fn() };
  const mockPrompts = {
    getActive: jest.fn().mockResolvedValue({ name: "test.prompt", version: 1, template: "You are a test classifier." }),
  };
  const mockLogging = { log: jest.fn() };
  const mockCache = { get: jest.fn(), set: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockCache.get.mockResolvedValue(null);

    const moduleRef = await Test.createTestingModule({
      providers: [
        AiGatewayService,
        { provide: GroqClient, useValue: mockGroq },
        ModelRouterService,
        SchemaValidatorService,
        TokenBudgetService,
        RedactionService,
        { provide: PromptRegistryService, useValue: mockPrompts },
        { provide: AiLoggingService, useValue: mockLogging },
        { provide: AiCacheService, useValue: mockCache },
        {
          provide: require("@nestjs/config").ConfigService,
          useValue: { get: jest.fn((key: string) => (key === "ai.smallModel" ? "test-small-model" : "test-large-model")) },
        },
      ],
    }).compile();

    service = moduleRef.get(AiGatewayService);
  });

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
    // second call's messages should include the correction instruction
    const secondCallMessages = mockGroq.chat.mock.calls[1][0].messages;
    expect(secondCallMessages.some((m: { content: string }) => m.content.includes("did not match the required shape"))).toBe(true);
  });

  it("throws AiValidationException after exhausting all correction attempts", async () => {
    mockGroq.chat.mockResolvedValue({ content: "still not json", model: "test-small-model", promptTokens: 0, completionTokens: 0 });

    await expect(
      service.classify("blah", ["ping", "other"], { feature: "test", promptName: "test.prompt" }),
    ).rejects.toThrow(AiValidationException);

    expect(mockGroq.chat).toHaveBeenCalledTimes(3); // 1 initial + 2 corrective retries
    expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ status: "MALFORMED_FALLBACK" }));
  });

  it("returns a cached result without calling Groq when a cache entry exists", async () => {
    mockCache.get.mockResolvedValue({ result: { label: "ping" }, confidence: 0.99 });

    const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

    expect(result.data.label).toBe("ping");
    expect(result.meta.cacheHit).toBe(true);
    expect(mockGroq.chat).not.toHaveBeenCalled();
  });

  // Regression test: previously a GroqClient failure (AiUnavailableException) propagated
  // straight out of runStructured without ever calling AiLoggingService.log(), so
  // AiInteractionLog never got an "ERROR" row for real outages and GET /ai/health's
  // errorRate silently under-counted them. AiGatewayService must now log status "ERROR"
  // before rethrowing, and must NOT itself retry the transport failure (GroqClient
  // already exhausted its own retry budget before throwing).
  it("logs status ERROR and rethrows AiUnavailableException as-is when Groq itself fails, without retrying", async () => {
    const transportError = new AiUnavailableException("HTTP 503 from Groq");
    mockGroq.chat.mockRejectedValue(transportError);

    await expect(
      service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" }),
    ).rejects.toBe(transportError);

    expect(mockGroq.chat).toHaveBeenCalledTimes(1); // no gateway-level retry of a transport failure
    expect(mockLogging.log).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ERROR",
        feature: "test",
        promptName: "test.prompt",
        errorMessage: expect.stringContaining("HTTP 503 from Groq"),
      }),
    );
  });

  it("preserves AiUnavailableException's type/status code when rethrown, so caller fallback catches still work", async () => {
    mockGroq.chat.mockRejectedValue(new AiUnavailableException("network timeout"));

    try {
      await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });
      fail("expected classify() to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AiUnavailableException);
    }
  });

  // Regression test: previously an AiCacheService.get() failure (e.g. Redis outage)
  // propagated straight out of runStructured and failed the entire AI call, even though
  // AiLoggingService's own failures are explicitly documented as fail-open. Cache reads
  // must degrade to "treat as cache miss, call Groq" instead.
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

  // Regression test: same fail-open contract for the write side of the cache.
  it("still returns a successful result when AiCacheService.set() throws after a fresh Groq call", async () => {
    mockCache.set.mockRejectedValue(new Error("ECONNREFUSED: redis down"));
    mockGroq.chat.mockResolvedValue({
      content: JSON.stringify({ result: { label: "ping" }, confidence: 0.9 }),
      model: "test-small-model",
      promptTokens: 10,
      completionTokens: 5,
    });

    const result = await service.classify("ping", ["ping", "other"], { feature: "test", promptName: "test.prompt" });

    expect(result.data.label).toBe("ping");
    expect(mockLogging.log).toHaveBeenCalledWith(expect.objectContaining({ status: "OK" }));
  });
});
