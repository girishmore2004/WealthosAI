import { Test } from "@nestjs/testing";
import { HybridRetrievalService } from "../src/ai/rag/retrieval/hybrid-retrieval.service";
import { EmbeddingService } from "../src/ai/rag/embedding/embedding.service";
import { KeywordScorerService } from "../src/ai/rag/retrieval/keyword-scorer.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("HybridRetrievalService", () => {
  let service: HybridRetrievalService;
  const mockPrisma = { client: { aiEmbeddingChunk: { findMany: jest.fn() } } };
  const mockEmbedding = { embed: jest.fn() };

  const now = new Date();
  const recentDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
  const oldDate = new Date(now.getTime() - 400 * 24 * 60 * 60 * 1000); // ~13 months ago

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HybridRetrievalService,
        KeywordScorerService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EmbeddingService, useValue: mockEmbedding },
      ],
    }).compile();
    service = moduleRef.get(HybridRetrievalService);
  });

  it("returns an empty array when the user has no indexed chunks", async () => {
    mockPrisma.client.aiEmbeddingChunk.findMany.mockResolvedValue([]);
    const results = await service.search("user-1", "home loan");
    expect(results).toEqual([]);
    expect(mockEmbedding.embed).not.toHaveBeenCalled(); // no point embedding a query against zero candidates
  });

  it("scopes the query to the requesting user only", async () => {
    mockPrisma.client.aiEmbeddingChunk.findMany.mockResolvedValue([]);
    await service.search("user-1", "home loan");
    expect(mockPrisma.client.aiEmbeddingChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ userId: "user-1" }) }),
    );
  });

  it("ranks a recent, semantically-similar, high-priority chunk above an old, dissimilar, low-priority one", async () => {
    mockEmbedding.embed.mockResolvedValue([1, 0, 0]);
    mockPrisma.client.aiEmbeddingChunk.findMany.mockResolvedValue([
      {
        id: "chunk-strong",
        sourceType: "DOCUMENT",
        sourceId: "doc-1",
        text: "home loan prepayment details",
        metadata: { title: "Loan doc" },
        embedding: [1, 0, 0], // identical to query embedding -> cosine similarity 1
        sourcePriority: 3,
        sourceCreatedAt: recentDate,
      },
      {
        id: "chunk-weak",
        sourceType: "ALERT",
        sourceId: "alert-1",
        text: "unrelated grocery spending alert",
        metadata: { title: "Alert" },
        embedding: [0, 1, 0], // orthogonal -> cosine similarity 0
        sourcePriority: 1,
        sourceCreatedAt: oldDate,
      },
    ]);

    const results = await service.search("user-1", "home loan prepayment");
    expect(results[0].id).toBe("chunk-strong");
    expect(results[0].combinedScore).toBeGreaterThan(results[1].combinedScore);
  });

  it("applies sourceType and date filters to the Prisma query", async () => {
    mockPrisma.client.aiEmbeddingChunk.findMany.mockResolvedValue([]);
    const dateFrom = new Date("2026-01-01");
    const dateTo = new Date("2026-06-01");
    await service.search("user-1", "tax", { sourceTypes: ["DOCUMENT", "REPORT"], dateFrom, dateTo });

    expect(mockPrisma.client.aiEmbeddingChunk.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          sourceType: { in: ["DOCUMENT", "REPORT"] },
          sourceCreatedAt: { gte: dateFrom, lte: dateTo },
        }),
      }),
    );
  });

  describe("hasEvidence", () => {
    it("is true when at least one chunk clears the minimum semantic similarity threshold", () => {
      const chunks = [{ semanticScore: 0.6 } as never];
      expect(service.hasEvidence(chunks)).toBe(true);
    });

    it("is false when every chunk is below the threshold", () => {
      const chunks = [{ semanticScore: 0.1 } as never, { semanticScore: 0.2 } as never];
      expect(service.hasEvidence(chunks)).toBe(false);
    });

    it("is false for an empty candidate list", () => {
      expect(service.hasEvidence([])).toBe(false);
    });
  });
});
