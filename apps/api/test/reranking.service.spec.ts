import { RerankingService } from "../src/ai/rag/retrieval/reranking.service";
import { AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { ScoredChunk } from "../src/ai/rag/retrieval/hybrid-retrieval.service";

function makeChunk(id: string, combinedScore: number): ScoredChunk {
  return {
    id,
    sourceType: "DOCUMENT",
    sourceId: `src-${id}`,
    text: `text for ${id}`,
    metadata: {},
    sourceCreatedAt: new Date(),
    semanticScore: combinedScore,
    keywordScore: 0,
    recencyScore: 0,
    priorityScore: 0,
    combinedScore,
  };
}

describe("RerankingService", () => {
  it("returns an empty result for zero candidates without calling the gateway", async () => {
    const mockGateway = { rank: jest.fn() };
    const service = new RerankingService(mockGateway as never);
    const result = await service.rerank("user-1", "query", []);
    expect(result.chunks).toEqual([]);
    expect(mockGateway.rank).not.toHaveBeenCalled();
  });

  it("uses the model's ordering when the gateway call succeeds", async () => {
    const chunks = [makeChunk("a", 0.5), makeChunk("b", 0.9)];
    const mockGateway = {
      rank: jest.fn().mockResolvedValue({
        data: { orderedIndices: [1, 0], rationale: "b is more relevant" },
        confidence: 0.8,
      }),
    };
    const service = new RerankingService(mockGateway as never);
    const result = await service.rerank("user-1", "query", chunks);
    expect(result.chunks.map((c) => c.id)).toEqual(["b", "a"]);
    expect(result.confidence).toBe(0.8);
  });

  it("falls back to hybrid retrieval's own order when the gateway is unavailable", async () => {
    const chunks = [makeChunk("a", 0.9), makeChunk("b", 0.5)];
    const mockGateway = { rank: jest.fn().mockRejectedValue(new AiUnavailableException("no key configured")) };
    const service = new RerankingService(mockGateway as never);
    const result = await service.rerank("user-1", "query", chunks);
    expect(result.chunks.map((c) => c.id)).toEqual(["a", "b"]);
    expect(result.rationale).toMatch(/unavailable/i);
  });

  it("keeps candidates the model forgot to rank, appended after the ones it did", async () => {
    const chunks = [makeChunk("a", 0.5), makeChunk("b", 0.9), makeChunk("c", 0.3)];
    const mockGateway = {
      rank: jest.fn().mockResolvedValue({
        data: { orderedIndices: [1], rationale: "only b was clearly relevant" }, // model only ranked index 1 (chunk "b")
        confidence: 0.7,
      }),
    };
    const service = new RerankingService(mockGateway as never);
    const result = await service.rerank("user-1", "query", chunks);
    expect(result.chunks[0].id).toBe("b");
    expect(result.chunks.map((c) => c.id)).toEqual(expect.arrayContaining(["a", "b", "c"]));
  });
});
