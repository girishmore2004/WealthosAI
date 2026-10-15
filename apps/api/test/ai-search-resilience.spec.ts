import { z } from "zod";
import { coerceConfidence, rankingEnvelope, withConfidence } from "../src/ai/gateway/ai-gateway.types";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { withStageTimeout } from "../src/ai/rag/stage-timeout";
import { AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";
import { RerankingService } from "../src/ai/rag/retrieval/reranking.service";
import { GroqClient } from "../src/ai/groq/groq.client";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { GroundingService } from "../src/ai/gateway/grounding.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";

describe("confidence given as a string by the model", () => {
  it("accepts numeric strings, percentages and words instead of failing the whole response", () => {
    expect(coerceConfidence("0.8")).toBe(0.8);
    expect(coerceConfidence("85%")).toBe(0.85);
    expect(coerceConfidence("85")).toBe(0.85);
    expect(coerceConfidence("High")).toBe(0.85);
    expect(coerceConfidence(0.4)).toBe(0.4);
    expect(coerceConfidence(7)).toBe(7); // a real number is never rewritten: it still fails the 0-1 range check
    expect(coerceConfidence("maybe")).toBe("maybe");
    expect(coerceConfidence("maybe", true)).toBeUndefined();
  });

  it("the ranking envelope takes a string confidence, falls back to its default for junk, and still rejects out-of-range numbers", () => {
    const ok = rankingEnvelope.safeParse({ result: { orderedIndices: [1, 0], rationale: "x" }, confidence: "0.7" });
    expect(ok.success && ok.data.confidence).toBe(0.7);
    const junk = rankingEnvelope.safeParse({ result: { orderedIndices: [1, 0], rationale: "x" }, confidence: "very sure" });
    expect(junk.success && junk.data.confidence).toBe(0.5);
    const missing = rankingEnvelope.safeParse({ result: { orderedIndices: [1, 0], rationale: "x" } });
    expect(missing.success && missing.data.confidence).toBe(0.5);
    expect(rankingEnvelope.safeParse({ result: { orderedIndices: [0], rationale: "x" }, confidence: 7 }).success).toBe(false);
  });

  it("a strict envelope still requires a readable confidence", () => {
    const schema = withConfidence(z.object({ a: z.string() }));
    expect(schema.safeParse({ result: { a: "x" }, confidence: "high" }).success).toBe(true);
    expect(schema.safeParse({ result: { a: "x" }, confidence: "whatever" }).success).toBe(false);
    expect(schema.safeParse({ result: { a: "x" } }).success).toBe(false);
  });

  it("describes a defaulted confidence to the model as a number, not 'any'", () => {
    const description = new SchemaValidatorService().describe(rankingEnvelope);
    expect(description).toMatch(/"confidence": number/);
    expect(description).not.toMatch(/"confidence": any/);
  });
});

describe("withStageTimeout cancellation", () => {
  afterEach(() => jest.useRealTimers());

  it("aborts the signal handed to the work when the budget runs out", async () => {
    jest.useFakeTimers();
    let seen: AbortSignal | undefined;
    const pending = withStageTimeout((signal) => {
      seen = signal;
      return new Promise<never>(() => undefined);
    }, 1000, "Test stage");
    const assertion = expect(pending).rejects.toBeInstanceOf(AiUnavailableException);
    expect(seen?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(seen?.aborted).toBe(true);
  });

  it("does not abort work that finishes in time", async () => {
    let seen: AbortSignal | undefined;
    await expect(withStageTimeout(async (signal) => ((seen = signal), 5), 1000, "s")).resolves.toBe(5);
    expect(seen?.aborted).toBe(false);
  });
});

describe("reranker call options", () => {
  it("asks for the small model and passes a cancellation signal", async () => {
    const rank = jest.fn().mockResolvedValue({ data: { orderedIndices: [1, 0], rationale: "r" }, confidence: 0.9 });
    const service = new RerankingService({ rank } as never);
    const chunk = (id: string) => ({ id, sourceType: "DOCUMENT", text: id, combinedScore: 0.5, semanticScore: 0.5 }) as never;
    await service.rerank("u", "q", [chunk("a"), chunk("b")]);
    const options = rank.mock.calls[0][2];
    expect(options.complexityHint).toBe("low");
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("synthesis grounding context across pages of one document", () => {
  const chunk = (id: string, text: string, parentText: string) =>
    ({ id, sourceType: "DOCUMENT", sourceId: "doc-1", chunkIndex: 0, text, parentText, metadata: {}, sourceCreatedAt: new Date("2026-10-01"), combinedScore: 1, semanticScore: 1, rerankPosition: 0 }) as never;

  it("includes the text of every cited page, so a figure from page 9 is not reported as invented", async () => {
    const extract = jest.fn().mockResolvedValue({
      data: { hasEvidence: true, answer: "Premium: ₹8,126 [1]", citedIndices: [1] },
      confidence: 0.9,
      groundingScore: 1,
      hallucinationRisk: "low",
    });
    const service = new AnswerSynthesisService({ extract } as never);
    await service.synthesize("u", "premium?", [
      chunk("c1", "[Page 1] Insured GIRISH. Sum insured 500000", "[Page 1] Insured GIRISH. Sum insured 500000"),
      chunk("c9", "[Page 9] Total Premium 8126 Rupees Eight thousand", "[Page 9] Total Premium 8126 Rupees Eight thousand"),
    ]);
    const context: string = extract.mock.calls[0][2].groundingContext;
    expect(context).toContain("500000");
    expect(context).toContain("8126");
    // ...and the real grounding check agrees: the page-9 premium is now verified.
    const score = new GroundingService().score("Premium: ₹8,126 [1]", context);
    expect(score.unmatchedNumbers).toEqual([]);
  });
});

describe("GroqClient cancellation", () => {
  const config = { get: (key: string) => ({ "ai.groqApiKey": "k", "ai.groqApiBaseUrl": "http://x", "ai.requestTimeoutMs": 5000, "ai.maxRetries": 2 })[key] };
  const params = { model: "m", messages: [], temperature: 0, maxTokens: 10, jsonMode: true };
  afterEach(() => jest.restoreAllMocks());

  it("does not call the provider when the signal is already aborted", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const controller = new AbortController();
    controller.abort();
    await expect(new GroqClient(config as never).chat({ ...params, signal: controller.signal })).rejects.toBeInstanceOf(AiUnavailableException);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("cancels the in-flight request and does not retry when the signal aborts", async () => {
    const fetchMock = jest.spyOn(globalThis, "fetch").mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          (init as RequestInit).signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    const controller = new AbortController();
    const call = new GroqClient(config as never).chat({ ...params, signal: controller.signal });
    const assertion = expect(call).rejects.toBeInstanceOf(AiUnavailableException);
    setTimeout(() => controller.abort(), 10);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("policy numbers in uploaded documents", () => {
  const service = new RedactionService();
  const sample = "Policy No : 1234567890123456 Type of Policy : Super Star. Card 4111 1111 1111 1111. PAN ABCDE1234F.";

  it("redacts a labelled policy number by default (unchanged behaviour)", () => {
    expect(service.redact(sample).text).not.toContain("1234567890123456");
  });

  it("keeps a labelled policy number when asked, while still redacting everything else", () => {
    const out = service.redact(sample, { keepPolicyNumbers: true }).text;
    expect(out).toContain("Policy No : 1234567890123456");
    expect(out).not.toContain("4111");
    expect(out).not.toContain("ABCDE1234F");
  });

  it("keeps alphanumeric policy numbers and several in one text", () => {
    const out = service.redact("Policy Number: P/700006/01/2027/012345 and policy no: 9988776655443322", { keepPolicyNumbers: true }).text;
    expect(out).toContain("P/700006/01/2027/012345");
    expect(out).toContain("9988776655443322");
  });

  it("does not keep a bare number that is not labelled as a policy number", () => {
    const out = service.redact("Account 123456789012345 and ref 1234567890123456", { keepPolicyNumbers: true }).text;
    expect(out).not.toContain("123456789012345");
    expect(out).not.toContain("1234567890123456");
  });
});
