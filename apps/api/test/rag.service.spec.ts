import { RagService } from "../src/ai/rag/rag.service";
import { ScoredChunk } from "../src/ai/rag/retrieval/hybrid-retrieval.service";

function makeChunk(id: string, semanticScore: number): ScoredChunk {
  return {
    id,
    sourceType: "DOCUMENT",
    sourceId: `src-${id}`,
    text: `some text for ${id}`,
    metadata: { title: `Doc ${id}` },
    sourceCreatedAt: new Date(),
    semanticScore,
    keywordScore: 0,
    recencyScore: 0,
    priorityScore: 0,
    combinedScore: semanticScore,
  };
}

describe("RagService.search", () => {
  const mockPrisma = { client: { aiSearchLog: { create: jest.fn().mockResolvedValue({}) } } };

  it("returns the no-evidence answer and skips reranking/synthesis when nothing clears the evidence threshold", async () => {
    const mockQueryRewrite = {
      plan: jest.fn().mockResolvedValue({ originalQuery: "q", rewrittenQueries: ["q"], isMultiHop: false, subQuestions: [] }),
    };
    const weakChunks = [makeChunk("a", 0.1)];
    const mockRetrieval = {
      search: jest.fn().mockResolvedValue(weakChunks),
      hasEvidence: jest.fn().mockReturnValue(false),
    };
    const mockReranking = { rerank: jest.fn() };
    const mockSynthesis = { synthesize: jest.fn() };

    const service = new RagService(
      mockPrisma as never,
      mockQueryRewrite as never,
      mockRetrieval as never,
      mockReranking as never,
      mockSynthesis as never,
    );

    const result = await service.search("user-1", "some obscure question");

    expect(result.hasEvidence).toBe(false);
    expect(result.citedSources).toEqual([]);
    expect(mockReranking.rerank).not.toHaveBeenCalled();
    expect(mockSynthesis.synthesize).not.toHaveBeenCalled();
    expect(mockPrisma.client.aiSearchLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hadEvidence: false }) }),
    );
  });

  it("runs the full pipeline and returns cited sources when evidence exists", async () => {
    const mockQueryRewrite = {
      plan: jest.fn().mockResolvedValue({ originalQuery: "q", rewrittenQueries: ["q", "q rephrased"], isMultiHop: false, subQuestions: [] }),
    };
    const strongChunks = [makeChunk("a", 0.8), makeChunk("b", 0.7)];
    const mockRetrieval = {
      search: jest.fn().mockResolvedValue(strongChunks),
      hasEvidence: jest.fn().mockReturnValue(true),
    };
    const rerankedChunks = strongChunks.map((c, i) => ({ ...c, rerankPosition: i }));
    const mockReranking = {
      rerank: jest.fn().mockResolvedValue({ chunks: rerankedChunks, rationale: "both relevant", confidence: 0.9 }),
    };
    const mockSynthesis = {
      synthesize: jest.fn().mockResolvedValue({
        hasEvidence: true,
        answer: "Your loan balance is X.",
        citedChunkIds: ["a"],
        confidence: 0.85,
      }),
    };

    const service = new RagService(
      mockPrisma as never,
      mockQueryRewrite as never,
      mockRetrieval as never,
      mockReranking as never,
      mockSynthesis as never,
    );

    const result = await service.search("user-1", "what's my loan balance");

    expect(result.hasEvidence).toBe(true);
    expect(result.answer).toBe("Your loan balance is X.");
    expect(result.citedSources).toHaveLength(1);
    expect(result.citedSources[0].chunkId).toBe("a");
    expect(result.answerConfidence).toBe(0.85);
    // retrievalConfidence should be derived from top semantic score + rerank confidence, not just echoed
    expect(result.retrievalConfidence).toBeGreaterThan(0);
    expect(mockPrisma.client.aiSearchLog.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ hadEvidence: true, citedChunkIds: ["a"] }) }),
    );
  });

  it("never fails the search if writing the search log itself fails", async () => {
    const failingPrisma = { client: { aiSearchLog: { create: jest.fn().mockRejectedValue(new Error("db down")) } } };
    const mockQueryRewrite = {
      plan: jest.fn().mockResolvedValue({ originalQuery: "q", rewrittenQueries: ["q"], isMultiHop: false, subQuestions: [] }),
    };
    const mockRetrieval = { search: jest.fn().mockResolvedValue([]), hasEvidence: jest.fn().mockReturnValue(false) };

    const service = new RagService(
      failingPrisma as never,
      mockQueryRewrite as never,
      mockRetrieval as never,
      { rerank: jest.fn() } as never,
      { synthesize: jest.fn() } as never,
    );

    await expect(service.search("user-1", "question")).resolves.toBeDefined();
  });
});
