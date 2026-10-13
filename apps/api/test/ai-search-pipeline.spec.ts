// The real PrismaService pulls in the generated client, which tries to load a native query engine when
// nothing here needs a database. Every test below uses hand-built doubles.
jest.mock("../src/prisma/prisma.service", () => ({ PrismaService: class PrismaService {} }));
jest.mock("@prisma/client", () => ({ ...jest.requireActual("@prisma/client"), PrismaClient: class PrismaClient {} }));

import { Logger } from "@nestjs/common";
import { RagService, buildSearchQueries } from "../src/ai/rag/rag.service";
import { RagController } from "../src/ai/rag/rag.controller";
import { QueryRewriteService } from "../src/ai/rag/retrieval/query-rewrite.service";
import { RerankingService } from "../src/ai/rag/retrieval/reranking.service";
import { AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";
import { ScoredChunk, mergeCandidatePools, suppressNearDuplicates } from "../src/ai/rag/retrieval/hybrid-retrieval.service";
import { withStageTimeout } from "../src/ai/rag/stage-timeout";
import { RAG_STAGE_TIMEOUTS_MS, RERANK_MAX_CORRECTIVE_RETRIES, REWRITE_MAX_CORRECTIVE_RETRIES } from "../src/ai/rag/rag.constants";
import { AiGroundingException, AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

function chunk(id: string, text: string, over: Partial<ScoredChunk> = {}): ScoredChunk {
  return {
    id,
    sourceType: "FINANCIAL_FACT",
    sourceId: `src-${id}`,
    chunkIndex: 0,
    text,
    parentText: text,
    metadata: { title: `Fact ${id}` },
    sourceCreatedAt: new Date("2026-10-01T00:00:00Z"),
    semanticScore: 0.7,
    keywordScore: 0.5,
    recencyScore: 0.5,
    priorityScore: 1,
    combinedScore: 0.8,
    relatedSourceIds: [],
    expansionReason: "seed",
    lexicalCoverage: 1,
    ...over,
  };
}

const plan = (over: Record<string, unknown> = {}) => ({
  originalQuery: "q",
  rewrittenQueries: ["What is my EMI?"],
  isMultiHop: false,
  subQuestions: [],
  queryType: "factual" as const,
  complexity: "simple" as const,
  planSource: "model" as const,
  planMeta: { cacheHit: false, retries: 0, rejectedPhrasings: 0, latencyMs: 5 },
  ...over,
});

function buildRag(over: { plan?: unknown; retrieval?: Record<string, unknown>; rerank?: unknown; synth?: unknown } = {}) {
  const prisma = { client: { aiSearchLog: { create: jest.fn().mockResolvedValue({}) } } };
  const queryRewrite = { plan: jest.fn().mockResolvedValue(over.plan ?? plan()) };
  const retrieval = {
    search: jest.fn().mockResolvedValue([chunk("a", "EMI 38500 per month")]),
    hasEvidence: jest.fn().mockReturnValue(true),
    ...over.retrieval,
  };
  const reranking = {
    rerank: jest.fn().mockResolvedValue(over.rerank ?? { chunks: [{ ...chunk("a", "EMI 38500 per month"), rerankPosition: 0 }], rationale: "ok", confidence: 0.9 }),
  };
  const synthesis = {
    synthesize: jest.fn().mockResolvedValue(
      over.synth ?? { hasEvidence: true, answer: "Your EMI is 38500.", citedChunkIds: ["a"], confidence: 0.9, groundingScore: 0.95, hallucinationRisk: "low" },
    ),
  };
  const service = new RagService(prisma as never, queryRewrite as never, retrieval as never, reranking as never, synthesis as never);
  return { service, prisma, queryRewrite, retrieval, reranking, synthesis };
}

describe("AI Search pipeline — ambiguity and no-evidence behaviour", () => {
  it("asks for clarification without planning, retrieving or calling any model", async () => {
    const { service, queryRewrite, retrieval, reranking, synthesis, prisma } = buildRag();
    const result = await service.search("user-1", "what about it?");
    expect(result.evidenceSufficiency).toBe("needs_clarification");
    expect(result.hasEvidence).toBe(false);
    expect(result.citedSources).toEqual([]);
    expect(result.answer).toMatch(/self-contained question/);
    expect(queryRewrite.plan).not.toHaveBeenCalled();
    expect(retrieval.search).not.toHaveBeenCalled();
    expect(reranking.rerank).not.toHaveBeenCalled();
    expect(synthesis.synthesize).not.toHaveBeenCalled();
    expect(prisma.client.aiSearchLog.create).toHaveBeenCalledTimes(1);
  });

  it("returns the controlled no-evidence answer (no invented figures) when nothing matches", async () => {
    const { service, reranking, synthesis } = buildRag({ retrieval: { search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) } });
    const result = await service.search("user-1", "Do I own any cryptocurrency?");
    expect(result.hasEvidence).toBe(false);
    expect(result.evidenceSufficiency).toBe("insufficient");
    expect(result.answer).toMatch(/no evidence/);
    expect(result.answer).not.toMatch(/\d/);
    expect(reranking.rerank).not.toHaveBeenCalled();
    expect(synthesis.synthesize).not.toHaveBeenCalled();
  });

  it("marks an answer whose figures could not be verified as 'unverified', never 'sufficient'", async () => {
    const { service } = buildRag({
      synth: { hasEvidence: true, answer: "I found information…", citedChunkIds: ["a"], confidence: 0, groundingScore: 0, hallucinationRisk: "high" },
    });
    const result = await service.search("user-1", "What is my EMI?");
    expect(result.evidenceSufficiency).toBe("unverified");
    expect(result.citedSources.map((c) => c.chunkId)).toEqual(["a"]);
  });

  it("tells the user when the index returned nothing at all, even if the live figures answered", async () => {
    const { service } = buildRag({
      retrieval: { search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) },
    });
    const result = await service.search("user-1", "Do I own any cryptocurrency?");
    expect(result.explanation).toMatch(/Reindex my data/);
  });

  it("never reports answer confidence above the measured grounding", async () => {
    const { service } = buildRag({
      synth: { hasEvidence: true, answer: "Spending was 111036.", citedChunkIds: ["a"], confidence: 0.99, groundingScore: 0.8, hallucinationRisk: "medium" },
    });
    const result = await service.search("user-1", "What is my EMI?");
    expect(result.answerConfidence).toBe(0.8);
    expect(result.evidenceSufficiency).toBe("partial");
  });

  it("reports what it read from the question without filtering on it", async () => {
    const { service, retrieval } = buildRag();
    const result = await service.search("user-1", "Show my expenses excluding rent in September 2026");
    expect(result.understanding?.negations).toEqual(["rent"]);
    expect(result.explanation).toMatch(/Read from your question/);
    // The filters passed to retrieval are exactly the ones the caller supplied (none) — nothing was inferred into them.
    for (const call of retrieval.search.mock.calls) expect(call[2]).toEqual({});
  });
});

describe("AI Search pipeline — retrieval efficiency, isolation and logging", () => {
  it("reads the user's chunk rows once and shares them across every phrasing", async () => {
    const rows = [{ id: "row" }];
    const loadCandidates = jest.fn().mockResolvedValue(rows);
    const { service, retrieval } = buildRag({
      plan: plan({ rewrittenQueries: ["What is my EMI?", "emi", "emi loan principal"] }),
      retrieval: { loadCandidates },
    });
    await service.search("user-1", "What is my EMI?");
    expect(loadCandidates).toHaveBeenCalledTimes(1);
    expect(loadCandidates).toHaveBeenCalledWith("user-1", {});
    expect(retrieval.search.mock.calls.length).toBeGreaterThan(1);
    for (const call of retrieval.search.mock.calls) {
      expect(call[0]).toBe("user-1");
      expect(call[3].candidates).toBe(rows);
    }
  });

  it("says so when nothing is indexed for the user, instead of silently answering from live records only", async () => {
    const { service } = buildRag({
      plan: plan({ rewrittenQueries: ["insurance policies", "policies on file"] }),
      retrieval: { loadCandidates: jest.fn().mockResolvedValue([]), search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) },
    });
    const result = await service.search("user-1", "What insurance policies do I have on file?");
    expect(result.explanation).toMatch(/Nothing is indexed for your account/);
    expect(result.explanation).toMatch(/Reindex/);
  });

  it("does not claim the index is empty when it has rows but nothing matched", async () => {
    const { service } = buildRag({
      plan: plan({ rewrittenQueries: ["a loan", "b loan"] }),
      retrieval: { loadCandidates: jest.fn().mockResolvedValue([{ id: "row" }]), search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) },
    });
    const result = await service.search("user-1", "Do I own any cryptocurrency?");
    expect(result.explanation).not.toMatch(/Nothing is indexed/);
  });

  it("scopes every retrieval stage to the requesting user", async () => {
    const { service, retrieval } = buildRag({ plan: plan({ rewrittenQueries: ["a loan", "b loan"] }) });
    await service.search("user-42", "loan details");
    for (const call of retrieval.search.mock.calls) expect(call[0]).toBe("user-42");
  });

  it("logs one summary line with counts and timings but never the question, the answer or a figure", async () => {
    const spy = jest.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      const { service } = buildRag();
      await service.search("user-1", "What is my secret loan EMI?");
      const lines = spy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("ai-search summary"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/"intent":"loans"/);
      expect(lines[0]).toMatch(/"candidatesRetrieved":/);
      expect(lines[0]).not.toMatch(/secret/);
      expect(lines[0]).not.toMatch(/38500/);
    } finally {
      spy.mockRestore();
    }
  });

  it("adds a normalised phrasing (ISO month, no exclusion clause) without exceeding the phrasing cap", () => {
    const queries = buildSearchQueries(["q1", "q2", "q3", "q4"], "How much did I spend on groceries in September 2026 excluding rent?");
    expect(queries.length).toBeLessThanOrEqual(5);
    expect(queries[queries.length - 1]).toBe("How much did I spend on groceries in 2026-09?");
    expect(buildSearchQueries(["What is my EMI?"], "What is my EMI?")).toEqual(["What is my EMI?"]);
  });
});

describe("AI Search evidence merging — duplicates, conflicts, stale sources", () => {
  const base = "Insurance policy Star Health health plan premium yearly coverage renewal date nominee policy details recorded for the user account";
  it("collapses true duplicates", () => {
    const kept = suppressNearDuplicates([chunk("a", `${base} 18500`), chunk("b", `${base} 18500`, { combinedScore: 0.5 })]);
    expect(kept.map((c) => c.id)).toEqual(["a"]);
  });
  it("keeps two chunks that read the same but state different figures, so a conflict can be reported", () => {
    const kept = suppressNearDuplicates([chunk("a", `${base} 18500`), chunk("b", `${base} 19500`, { combinedScore: 0.5 })]);
    expect(kept.map((c) => c.id).sort()).toEqual(["a", "b"]);
  });
  it("judges evidence by the best phrasing's lexical coverage while ranking by the best score", () => {
    const strict = chunk("a", "x", { combinedScore: 0.9, lexicalCoverage: 0.4 });
    const loose = chunk("a", "x", { combinedScore: 0.6, lexicalCoverage: 1 });
    const [merged] = mergeCandidatePools([[strict], [loose]]);
    expect(merged.combinedScore).toBe(0.9);
    expect(merged.lexicalCoverage).toBe(1);
  });
});

describe("AI Search stage budgets and bounded retries", () => {
  afterEach(() => jest.useRealTimers());

  it("withStageTimeout rejects with AiUnavailableException after the budget and clears its timer", async () => {
    jest.useFakeTimers();
    const pending = withStageTimeout(new Promise(() => undefined), 1000, "Test stage");
    const assertion = expect(pending).rejects.toBeInstanceOf(AiUnavailableException);
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(jest.getTimerCount()).toBe(0);
  });
  it("withStageTimeout passes through a fast result and a fast failure", async () => {
    await expect(withStageTimeout(Promise.resolve(7), 1000, "s")).resolves.toBe(7);
    await expect(withStageTimeout(Promise.reject(new Error("boom")), 1000, "s")).rejects.toThrow("boom");
  });

  it("query rewrite makes one attempt (no corrective retries) and falls back to the original query when it hangs", async () => {
    jest.useFakeTimers();
    const extract = jest.fn().mockReturnValue(new Promise(() => undefined));
    const service = new QueryRewriteService({ extract } as never);
    const planPromise = service.plan("user-1", "What is my home loan EMI?");
    await jest.advanceTimersByTimeAsync(RAG_STAGE_TIMEOUTS_MS.rewrite);
    const result = await planPromise;
    expect(extract).toHaveBeenCalledTimes(1);
    expect(extract.mock.calls[0][2].maxCorrectiveRetries).toBe(REWRITE_MAX_CORRECTIVE_RETRIES);
    expect(result.planSource).toBe("fallback");
    expect(result.rewrittenQueries).toEqual(["What is my home loan EMI?"]);
    expect(result.queryType).toBe("factual");
  });

  it("query rewrite falls back on invalid model output and on exhausted retries", async () => {
    for (const err of [new Error("schema validation failed"), new AiUnavailableException("HTTP 503")]) {
      const service = new QueryRewriteService({ extract: jest.fn().mockRejectedValue(err) } as never);
      const result = await service.plan("user-1", "How much premium do I pay?");
      expect(result.planSource).toBe("fallback");
      expect(result.rewrittenQueries).toEqual(["How much premium do I pay?"]);
    }
  });

  it("query rewrite drops rewrites that lose an amount, a period or a negation, and keeps the original first", async () => {
    const gateway = {
      extract: jest.fn().mockResolvedValue({
        data: {
          rewrittenQueries: ["premium above 2,000", "premiums over 20000 excluding rent", "policies with premium above 20,000"],
          isMultiHop: false,
          subQuestions: [],
          queryType: "factual",
          complexity: "simple",
        },
        meta: { cacheHit: true, retries: 0 },
      }),
    };
    const query = "premium above 20,000 excluding rent";
    const result = await new QueryRewriteService(gateway as never).plan("user-1", query);
    expect(result.rewrittenQueries[0]).toBe(query);
    expect(result.rewrittenQueries).toContain("premiums over 20000 excluding rent");
    expect(result.rewrittenQueries).not.toContain("premium above 2,000");
    expect(result.rewrittenQueries).not.toContain("policies with premium above 20,000"); // lost the exclusion
    expect(result.planMeta).toMatchObject({ cacheHit: true, rejectedPhrasings: 2 });
  });

  it("query rewrite refuses sub-questions that introduce a figure the user never wrote", async () => {
    const gateway = {
      extract: jest.fn().mockResolvedValue({
        data: { rewrittenQueries: ["compare spend"], isMultiHop: true, subQuestions: ["spend in 2026-09", "spend in 2025-01"], queryType: "comparative", complexity: "complex" },
      }),
    };
    const result = await new QueryRewriteService(gateway as never).plan("user-1", "compare spend in 2026-09 with 2026-08");
    expect(result.subQuestions).toEqual(["spend in 2026-09"]);
  });

  it("reranking makes one attempt and falls back to hybrid order when the model hangs", async () => {
    jest.useFakeTimers();
    const rank = jest.fn().mockReturnValue(new Promise(() => undefined));
    const service = new RerankingService({ rank } as never);
    const candidates = [chunk("lo", "a", { combinedScore: 0.2 }), chunk("hi", "b", { combinedScore: 0.9 })];
    const promise = service.rerank("user-1", "q", candidates, 2);
    await jest.advanceTimersByTimeAsync(RAG_STAGE_TIMEOUTS_MS.rerank);
    const result = await promise;
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][2].maxCorrectiveRetries).toBe(RERANK_MAX_CORRECTIVE_RETRIES);
    expect(result.chunks.map((c) => c.id)).toEqual(["hi", "lo"]);
    expect(result.rationale).toMatch(/unavailable/);
  });

  it("synthesis degrades to the 'unavailable' answer, keeping the citations, when the model hangs", async () => {
    jest.useFakeTimers();
    const gateway = { extract: jest.fn().mockReturnValue(new Promise(() => undefined)) };
    const promise = new AnswerSynthesisService(gateway as never).synthesize("user-1", "q", [{ ...chunk("a", "EMI 38500"), rerankPosition: 0 }]);
    await jest.advanceTimersByTimeAsync(RAG_STAGE_TIMEOUTS_MS.synthesis);
    const result = await promise;
    expect(result.answer).toMatch(/temporarily unavailable/);
    expect(result.citedChunkIds).toEqual(["a"]);
    expect(result.confidence).toBe(0);
  });

  it("synthesis never writes the unverified figures to the logs", async () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const gateway = { extract: jest.fn().mockRejectedValue(new AiGroundingException("rag.synthesis", ["61,750", "9,99,999"])) };
      const result = await new AnswerSynthesisService(gateway as never).synthesize("user-1", "q", [{ ...chunk("a", "EMI 38500"), rerankPosition: 0 }]);
      expect(result.hallucinationRisk).toBe("high");
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toMatch(/failed grounding verification/);
      expect(logged).not.toMatch(/61,750|9,99,999/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AI Search reindex", () => {
  const user = { id: "user-1" } as never;
  const job = (over: Record<string, unknown>) => ({ id: "job-1", status: "QUEUED", createdAt: new Date(), ...over });
  const build = (enqueue: jest.Mock) => new RagController({} as never, { enqueue } as never, {} as never);

  it("preserves the idempotent response for a queued, running or finished job", async () => {
    for (const status of ["QUEUED", "RUNNING", "DONE"]) {
      const enqueue = jest.fn().mockResolvedValue(job({ status, createdAt: new Date(Date.now() - 600_000) }));
      const result = await build(enqueue).reindex(user);
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ jobId: "job-1", status, reused: true });
    }
  });
  it("reports a freshly queued job as not reused", async () => {
    const result = await build(jest.fn().mockResolvedValue(job({}))).reindex(user);
    expect(result.reused).toBe(false);
  });
  it("replaces a FAILED job once, under a key derived from the failed job's id", async () => {
    const enqueue = jest
      .fn()
      .mockResolvedValueOnce(job({ id: "failed-1", status: "FAILED", createdAt: new Date(Date.now() - 600_000) }))
      .mockResolvedValueOnce(job({ id: "retry-1" }));
    const result = await build(enqueue).reindex(user);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(enqueue.mock.calls[1][2].idempotencyKey).toMatch(/^reindex:.+:retry:failed-1$/);
    expect(enqueue.mock.calls[1][2].userId).toBe("user-1");
    expect(result).toMatchObject({ jobId: "retry-1", status: "QUEUED" });
  });
});
