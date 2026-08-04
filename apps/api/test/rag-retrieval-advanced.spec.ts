import { suppressNearDuplicates, ScoredChunk } from "../src/ai/rag/retrieval/hybrid-retrieval.service";
import {
  adaptiveCandidateLimit,
  adaptiveRerankLimit,
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  MIN_RERANKED,
  MAX_RERANKED,
} from "../src/ai/rag/rag.constants";
import { QueryRewriteService } from "../src/ai/rag/retrieval/query-rewrite.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";

function makeChunk(id: string, text: string, combinedScore: number): ScoredChunk {
  return {
    id,
    sourceType: "DOCUMENT",
    sourceId: `src-${id}`,
    chunkIndex: 0,
    text,
    parentText: text,
    metadata: {},
    sourceCreatedAt: new Date(),
    semanticScore: combinedScore,
    keywordScore: 0,
    recencyScore: 0,
    priorityScore: 0,
    combinedScore,
    relatedSourceIds: [],
    expansionReason: "seed",
  };
}

describe("suppressNearDuplicates", () => {
  it("drops a near-duplicate chunk and keeps the higher-scored one", () => {
    const a = makeChunk("a", "Your home loan balance is 45 lakh with HDFC Bank as of July 2026", 0.9);
    const b = makeChunk("b", "Your home loan balance is 45 lakh with HDFC Bank as of July 2026.", 0.5);

    const result = suppressNearDuplicates([a, b], 0.82);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("a");
  });

  it("keeps chunks that are only topically related, not near-duplicates", () => {
    const a = makeChunk("a", "Your home loan balance is 45 lakh with HDFC Bank", 0.9);
    const b = makeChunk("b", "Your car insurance premium renews in September", 0.8);

    const result = suppressNearDuplicates([a, b], 0.82);

    expect(result).toHaveLength(2);
  });

  it("is a no-op for an empty or single-item list", () => {
    expect(suppressNearDuplicates([])).toEqual([]);
    const a = makeChunk("a", "some unique text", 0.5);
    expect(suppressNearDuplicates([a])).toEqual([a]);
  });
});

describe("adaptive top-k helpers", () => {
  it("scales candidate/rerank limits up for complex queries and down for simple ones", () => {
    const simple = adaptiveCandidateLimit("simple");
    const moderate = adaptiveCandidateLimit("moderate");
    const complex = adaptiveCandidateLimit("complex");

    expect(simple).toBeLessThan(moderate);
    expect(complex).toBeGreaterThan(moderate);
    expect(simple).toBeGreaterThanOrEqual(MIN_CANDIDATES);
    expect(complex).toBeLessThanOrEqual(MAX_CANDIDATES);

    const simpleRerank = adaptiveRerankLimit("simple");
    const complexRerank = adaptiveRerankLimit("complex");
    expect(simpleRerank).toBeLessThan(complexRerank);
    expect(simpleRerank).toBeGreaterThanOrEqual(MIN_RERANKED);
    expect(complexRerank).toBeLessThanOrEqual(MAX_RERANKED);
  });
});

describe("QueryRewriteService fallback classification", () => {
  it("falls back to a heuristic classification when the gateway is unavailable", async () => {
    const mockGateway = {
      extract: jest.fn().mockRejectedValue(new AiUnavailableException("groq down")),
    };
    const service = new QueryRewriteService(mockGateway as never);

    const simplePlan = await service.plan("user-1", "loan balance");
    expect(simplePlan.complexity).toBe("simple");
    expect(simplePlan.queryType).toBe("exploratory");
    expect(simplePlan.rewrittenQueries).toEqual(["loan balance"]);

    const complexPlan = await service.plan("user-1", "compare my spending this month vs last month and tell me if I'm on track");
    expect(complexPlan.complexity).toBe("complex");
  });

  it("uses the gateway's own classification when available", async () => {
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: {
          rewrittenQueries: ["what is my loan balance"],
          isMultiHop: false,
          subQuestions: [],
          queryType: "factual",
          complexity: "simple",
        },
      }),
    };
    const service = new QueryRewriteService(mockGateway as never);

    const plan = await service.plan("user-1", "loan balance?");
    expect(plan.queryType).toBe("factual");
    expect(plan.complexity).toBe("simple");
  });
});
