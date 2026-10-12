import { z } from "zod";
import { AiGatewayService } from "../src/ai/gateway/ai-gateway.service";
import { ModelRouterService } from "../src/ai/gateway/model-router.service";
import { ModelRoutingStatsService } from "../src/ai/gateway/model-routing-stats.service";
import { TokenAccountingService } from "../src/ai/gateway/token-accounting.service";
import { GroundingService } from "../src/ai/gateway/grounding.service";
import { SchemaValidatorService } from "../src/ai/gateway/schema-validator.service";
import { TokenBudgetService } from "../src/ai/gateway/token-budget.service";
import { RedactionService } from "../src/ai/gateway/redaction.service";
import {
  DEFAULT_RATIONALE,
  RATIONALE_MAX_CHARS,
  normalizeRationale,
  rankingEnvelope,
} from "../src/ai/gateway/ai-gateway.types";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";
import { RerankingService } from "../src/ai/rag/retrieval/reranking.service";
import { ScoredChunk } from "../src/ai/rag/retrieval/hybrid-retrieval.service";
import { RerankedChunk } from "../src/ai/rag/retrieval/reranking.service";

const CONFIG_VALUES: Record<string, unknown> = {
  "ai.smallModel": "test-small-model",
  "ai.largeModel": "test-large-model",
  "ai.fallbackModel": "test-fallback-model",
  "ai.semanticCacheThreshold": 0.94,
  "ai.modelPricing": {},
};

function buildGateway(chat: jest.Mock): AiGatewayService {
  return new AiGatewayService(
    { chat } as never,
    new ModelRouterService({ get: (k: string) => CONFIG_VALUES[k] } as never, new ModelRoutingStatsService()),
    new ModelRoutingStatsService(),
    new TokenAccountingService({ get: (k: string) => CONFIG_VALUES[k] } as never),
    new GroundingService(),
    new SchemaValidatorService(),
    new TokenBudgetService(),
    new RedactionService(),
    { getActive: jest.fn().mockResolvedValue({ name: "test.prompt", version: 1, template: "Test prompt." }) } as never,
    { log: jest.fn().mockResolvedValue(undefined) } as never,
    { get: jest.fn().mockResolvedValue(null), set: jest.fn(), getSemantic: jest.fn().mockResolvedValue(null), setSemantic: jest.fn() } as never,
    { get: (k: string) => CONFIG_VALUES[k] } as never,
  );
}

const completion = (payload: unknown) => ({
  content: typeof payload === "string" ? payload : JSON.stringify(payload),
  model: "test-small-model",
  promptTokens: 10,
  completionTokens: 10,
});

function rerankedChunk(id: string, text: string): RerankedChunk {
  return {
    id,
    sourceType: "FINANCIAL_FACT",
    sourceId: `src-${id}`,
    chunkIndex: 0,
    text,
    parentText: text,
    metadata: {},
    sourceCreatedAt: new Date("2026-09-30T00:00:00Z"),
    semanticScore: 0.8,
    keywordScore: 0.5,
    recencyScore: 0.5,
    priorityScore: 0.5,
    combinedScore: 0.8,
    relatedSourceIds: [],
    expansionReason: "seed",
    rerankPosition: 0,
  };
}

describe("RAG synthesis grounding (rag.synthesis false positive: 'figures not present: 0,1,2')", () => {
  const chunks = [
    rerankedChunk("a", "Home loan EMI is ₹45,200 per month. Interest rate 8.5%."),
    rerankedChunk("b", "Outstanding balance ₹32,50,000 as of 2026-09-30."),
    rerankedChunk("c", "SIP of ₹10,000 per month into an index fund."),
  ];

  it("does not retry when the answer's figures are supported and citations are [0,1,2]", async () => {
    const chat = jest.fn().mockResolvedValue(
      completion({
        result: {
          hasEvidence: true,
          answer: "Your home loan EMI is ₹45,200 per month at 8.5%, with ₹32,50,000 outstanding, and you invest ₹10,000 monthly via SIP.",
          citedIndices: [0, 1, 2],
        },
        confidence: 0.9,
      }),
    );
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "Summarise my loan and SIP", chunks);

    expect(chat).toHaveBeenCalledTimes(1); // no corrective retry
    expect(result.hasEvidence).toBe(true);
    expect(result.citedChunkIds).toEqual(["a", "b", "c"]);
    expect(result.hallucinationRisk).not.toBe("high");
  });

  it("does not retry for a numbered-list answer whose figures are all supported", async () => {
    const chat = jest.fn().mockResolvedValue(
      completion({
        result: {
          hasEvidence: true,
          answer: "1. EMI: ₹45,200 per month.\n2. Interest rate: 8.5%.\n3. Outstanding: ₹32,50,000.",
          citedIndices: [0, 1],
        },
        confidence: 0.9,
      }),
    );
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "loan details", chunks);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.answer).toContain("₹45,200");
  });

  it("still retries and then degrades safely when the answer invents a financial figure", async () => {
    const chat = jest.fn().mockResolvedValue(
      completion({
        result: { hasEvidence: true, answer: "Your EMI is ₹61,750 per month.", citedIndices: [0, 1, 2] },
        confidence: 0.9,
      }),
    );
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "What is my EMI?", chunks);

    expect(chat).toHaveBeenCalledTimes(3); // initial + 2 corrective retries (unchanged shared behaviour)
    expect(result.hallucinationRisk).toBe("high");
    expect(result.answer).toMatch(/couldn't verify/);
    // The correction names the invented figure, not the citation indices.
    const correction = chat.mock.calls[1][0].messages.at(-1).content as string;
    expect(correction).toContain("61,750");
    expect(correction).not.toContain("0,1,2");
  });

  it("falls back to the unavailable answer on provider failure", async () => {
    const chat = jest.fn().mockRejectedValue(new AiUnavailableException("HTTP 503 from Groq"));
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "What is my EMI?", chunks);

    expect(result.hasEvidence).toBe(true);
    expect(result.answer).toMatch(/temporarily unavailable/);
    expect(result.citedChunkIds).toEqual(["a", "b", "c"]);
    expect(result.hallucinationRisk).toBe("unmeasured");
  });

  it("falls back to the unavailable answer on malformed output", async () => {
    const chat = jest.fn().mockResolvedValue(completion("this is not json"));
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "What is my EMI?", chunks);

    expect(result.answer).toMatch(/temporarily unavailable/);
    expect(chat).toHaveBeenCalledTimes(3);
  });

  it("returns the no-evidence answer without calling the model when there is no retrieved context", async () => {
    const chat = jest.fn();
    const service = new AnswerSynthesisService(buildGateway(chat));

    const result = await service.synthesize("user-1", "What is my EMI?", []);

    expect(result.hasEvidence).toBe(false);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("normalizeRationale (rag.rerank 'rationale: String must contain at most 500 character(s)')", () => {
  it("keeps a short rationale unchanged", () => {
    expect(normalizeRationale("Best match for the EMI question.")).toBe("Best match for the EMI question.");
  });

  it("keeps a rationale of exactly the limit unchanged", () => {
    const exact = "a".repeat(RATIONALE_MAX_CHARS);
    expect(normalizeRationale(exact)).toBe(exact);
  });

  it("shortens a rationale one character over the limit to within the limit", () => {
    const input = "word ".repeat(100).trim() + "xx"; // 499 + 2 = 501 characters
    expect(input.length).toBe(RATIONALE_MAX_CHARS + 1);
    const out = normalizeRationale(input);
    expect(out.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    expect(out.endsWith("\u2026")).toBe(true);
  });

  it("cuts a very long rationale at a sentence boundary when one is available", () => {
    const sentence = "Snippet two directly states the EMI amount. ";
    const out = normalizeRationale(sentence.repeat(60));
    expect(out.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toContain("\u2026");
  });

  it("hard-cuts a long string with no spaces and still stays within the limit", () => {
    const out = normalizeRationale("x".repeat(5000));
    expect(out.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
  });

  it("never splits a surrogate pair at the cut", () => {
    const out = normalizeRationale("😀".repeat(400));
    expect(out.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    const body = out.replace("\u2026", "");
    expect([...body].every((ch) => ch === "😀")).toBe(true);
  });

  it("collapses whitespace padding before measuring", () => {
    expect(normalizeRationale("  Good   match \n\n here  ")).toBe("Good match here");
  });

  it("uses the default for missing, empty, whitespace-only and non-string values", () => {
    for (const bad of [undefined, null, "", "   \n\t ", 42, { text: "x" }, ["a"]]) {
      expect(normalizeRationale(bad)).toBe(DEFAULT_RATIONALE);
    }
  });
});

describe("rankingEnvelope / AiGatewayService.rank with an overlong rationale", () => {
  const validator = new SchemaValidatorService();

  it("accepts an overlong rationale by normalising it, preserving indices and confidence", () => {
    const parsed = validator.parse(
      rankingEnvelope,
      JSON.stringify({ result: { orderedIndices: [2, 0, 1], rationale: "r".repeat(900) }, confidence: 0.77 }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.result.orderedIndices).toEqual([2, 0, 1]);
    expect(parsed.data?.result.rationale.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    expect(parsed.data?.confidence).toBe(0.77);
  });

  it("accepts a missing rationale and fills the default", () => {
    const parsed = validator.parse(rankingEnvelope, JSON.stringify({ result: { orderedIndices: [1, 0] }, confidence: 0.5 }));
    expect(parsed.ok).toBe(true);
    expect(parsed.data?.result.rationale).toBe(DEFAULT_RATIONALE);
  });

  it("still rejects genuinely malformed structure (indices must be non-negative integers)", () => {
    const parsed = validator.parse(
      rankingEnvelope,
      JSON.stringify({ result: { orderedIndices: ["a", -1], rationale: "ok" }, confidence: 0.5 }),
    );
    expect(parsed.ok).toBe(false);
    expect(parsed.issues?.join(" ")).toContain("orderedIndices");
  });

  it("tells the model about the length limit in the schema description", () => {
    expect(validator.describe(rankingEnvelope)).toContain("at most 500 characters");
  });

  it("gateway.rank succeeds on the first attempt when the rationale is overlong (no retry)", async () => {
    const chat = jest
      .fn()
      .mockResolvedValue(completion({ result: { orderedIndices: [1, 0], rationale: "long ".repeat(300) }, confidence: 0.8 }));
    const gateway = buildGateway(chat);

    const result = await gateway.rank(["a", "b"], "criterion", { feature: "rag.rerank", promptName: "test.prompt", cacheable: false });

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.meta.retries).toBe(0);
    expect(result.data.orderedIndices).toEqual([1, 0]);
    expect(result.data.rationale.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
  });
});

describe("RerankingService with the real gateway", () => {
  function candidate(id: string, combinedScore: number, semanticScore: number): ScoredChunk {
    return { ...rerankedChunk(id, `text for ${id}`), combinedScore, semanticScore } as ScoredChunk;
  }
  const candidates = [candidate("a", 0.9, 0.9), candidate("b", 0.7, 0.7), candidate("c", 0.5, 0.6)];

  it("keeps the model's order and every chunk's own scores when the rationale is overlong", async () => {
    const chat = jest
      .fn()
      .mockResolvedValue(completion({ result: { orderedIndices: [2, 0, 1], rationale: "because ".repeat(200) }, confidence: 0.85 }));
    const service = new RerankingService(buildGateway(chat));

    const result = await service.rerank("user-1", "what is my EMI", candidates, 3);

    expect(chat).toHaveBeenCalledTimes(1);
    expect(result.chunks.map((c) => c.id)).toEqual(["c", "a", "b"]);
    expect(result.chunks.map((c) => c.rerankPosition)).toEqual([0, 1, 2]);
    expect(result.chunks.find((c) => c.id === "a")?.combinedScore).toBe(0.9);
    expect(result.chunks.find((c) => c.id === "c")?.semanticScore).toBe(0.6);
    expect(result.rationale.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
    expect(result.confidence).toBe(0.85);
  });

  it("collapses duplicate indices and appends omitted candidates in hybrid order", async () => {
    const chat = jest
      .fn()
      .mockResolvedValue(completion({ result: { orderedIndices: [1, 1, 99], rationale: "ok" }, confidence: 0.6 }));
    const service = new RerankingService(buildGateway(chat));

    const result = await service.rerank("user-1", "q", candidates, 3);

    expect(result.chunks.map((c) => c.id)).toEqual(["b", "a", "c"]);
  });

  it("falls back to hybrid-score order with a valid rationale on provider failure", async () => {
    const chat = jest.fn().mockRejectedValue(new AiUnavailableException("HTTP 503 from Groq"));
    const service = new RerankingService(buildGateway(chat));

    const result = await service.rerank("user-1", "q", [candidates[2], candidates[0], candidates[1]], 3);

    expect(result.chunks.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(result.rationale.length).toBeLessThanOrEqual(RATIONALE_MAX_CHARS);
  });

  it("falls back to hybrid-score order on malformed JSON output", async () => {
    const chat = jest.fn().mockResolvedValue(completion("not json"));
    const service = new RerankingService(buildGateway(chat));

    const result = await service.rerank("user-1", "q", candidates, 3);

    expect(result.chunks.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });

  it("returns early without a model call for zero or one candidate", async () => {
    const chat = jest.fn();
    const service = new RerankingService(buildGateway(chat));

    expect((await service.rerank("user-1", "q", [], 3)).chunks).toEqual([]);
    expect((await service.rerank("user-1", "q", [candidates[0]], 3)).chunks).toHaveLength(1);
    expect(chat).not.toHaveBeenCalled();
  });
});

describe("gateway retry cap option", () => {
  it("maxCorrectiveRetries: 1 stops after two attempts on a persistent schema failure", async () => {
    const chat = jest.fn().mockResolvedValue(completion({ result: { value: "wrong shape" }, confidence: 0.5 }));
    const gateway = buildGateway(chat);

    await expect(
      gateway.extract("input", z.object({ n: z.number() }), {
        feature: "test",
        promptName: "test.prompt",
        cacheable: false,
        maxCorrectiveRetries: 1,
      }),
    ).rejects.toThrow(/failed schema validation after 2 retries/);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("defaults to the unchanged three-attempt behaviour", async () => {
    const chat = jest.fn().mockResolvedValue(completion({ result: { value: "wrong shape" }, confidence: 0.5 }));
    const gateway = buildGateway(chat);

    await expect(
      gateway.extract("input", z.object({ n: z.number() }), { feature: "test", promptName: "test.prompt", cacheable: false }),
    ).rejects.toThrow(/failed schema validation after 3 retries/);
    expect(chat).toHaveBeenCalledTimes(3);
  });
});
