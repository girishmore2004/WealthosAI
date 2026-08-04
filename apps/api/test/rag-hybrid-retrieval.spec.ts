import { HybridRetrievalService } from "../src/ai/rag/retrieval/hybrid-retrieval.service";

function embeddingFor(text: string): number[] {
  // Deterministic 3-dim pseudo-embedding derived from the text so cosine similarity
  // is meaningful in these tests without a real model — identical text -> identical
  // vector -> similarity 1; unrelated text -> a very different vector.
  const hash = [...text].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const v = [Math.sin(hash), Math.cos(hash), Math.sin(hash / 2)];
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: overrides.id ?? "id-1",
    userId: "user-1",
    sourceType: "DOCUMENT",
    sourceId: overrides.sourceId ?? "source-1",
    chunkIndex: overrides.chunkIndex ?? 0,
    text: overrides.text ?? "some loan text",
    parentText: overrides.parentText ?? overrides.text ?? "some loan text",
    metadata: overrides.metadata ?? {},
    embedding: embeddingFor(String(overrides.text ?? "some loan text")),
    sourcePriority: overrides.sourcePriority ?? 2,
    sourceCreatedAt: overrides.sourceCreatedAt ?? new Date(),
    embeddingModelVersion: 1,
    relatedSourceIds: overrides.relatedSourceIds ?? [],
    ...overrides,
  };
}

function makeService(findManyImpl: (args: unknown) => unknown) {
  const mockPrisma = { client: { aiEmbeddingChunk: { findMany: jest.fn(findManyImpl) } } };
  const mockEmbedding = { embed: jest.fn(async (text: string) => embeddingFor(text)) };
  const mockKeywordScorer = { score: jest.fn((_query: string, texts: string[]) => texts.map(() => 0.5)) };
  return new HybridRetrievalService(mockPrisma as never, mockEmbedding as never, mockKeywordScorer as never);
}

describe("HybridRetrievalService", () => {
  it("filters out DOCUMENT chunks whose category doesn't match the requested categories", async () => {
    const rows = [
      row({ id: "a", sourceId: "s-a", text: "insurance policy detail", metadata: { category: "INSURANCE" } }),
      row({ id: "b", sourceId: "s-b", text: "loan agreement detail", metadata: { category: "LOAN" } }),
    ];
    const service = makeService(() => rows);

    const results = await service.search("user-1", "loan agreement detail", { categories: ["LOAN"] });

    expect(results.map((r) => r.id)).toEqual(["b"]);
  });

  it("does not apply the category filter to non-DOCUMENT source types", async () => {
    const rows = [row({ id: "a", sourceType: "ALERT", sourceId: "s-a", text: "alert text", metadata: {} })];
    const service = makeService(() => rows);

    const results = await service.search("user-1", "alert text", { categories: ["LOAN"] });

    expect(results.map((r) => r.id)).toEqual(["a"]);
  });

  it("filters by tags with OR semantics", async () => {
    const rows = [
      row({ id: "a", sourceId: "s-a", text: "doc a", metadata: { tags: ["home"] } }),
      row({ id: "b", sourceId: "s-b", text: "doc b", metadata: { tags: ["car"] } }),
    ];
    const service = makeService(() => rows);

    const results = await service.search("user-1", "doc", { tags: ["car", "boat"] });

    expect(results.map((r) => r.id)).toEqual(["b"]);
  });

  it("expands the candidate pool with sibling chunks from the same source within the expansion radius", async () => {
    const seedRow = row({ id: "seed", sourceId: "shared-source", chunkIndex: 5, text: "the matched passage about the loan" });
    const siblingRow = row({ id: "sibling", sourceId: "shared-source", chunkIndex: 6, text: "an unrelated adjacent sentence" });
    const farRow = row({ id: "far", sourceId: "shared-source", chunkIndex: 20, text: "a far-away chunk" });

    const findMany = jest.fn((args: { where: { sourceId?: { in: string[] } } }) => {
      // First call: the broad initial candidate fetch. Second call: expansion lookup
      // scoped to sourceId — distinguish by presence of the `sourceId.in` filter.
      if (args.where.sourceId) return [seedRow, siblingRow, farRow];
      return [seedRow];
    });
    const service = makeService(findMany);

    const results = await service.search("user-1", "the matched passage about the loan");

    const ids = results.map((r) => r.id);
    expect(ids).toContain("sibling");
    expect(ids).not.toContain("far");
  });

  it("expands the candidate pool with related-source chunks recorded at index time", async () => {
    const seedRow = row({ id: "seed", sourceId: "report-1", chunkIndex: 0, text: "monthly report summary", relatedSourceIds: ["snapshot-1"] });
    const relatedRow = row({ id: "related", sourceId: "snapshot-1", chunkIndex: 0, text: "current snapshot detail" });

    const findMany = jest.fn((args: { where: { sourceId?: { in: string[] } } }) => {
      if (args.where.sourceId) return [seedRow, relatedRow];
      return [seedRow];
    });
    const service = makeService(findMany);

    const results = await service.search("user-1", "monthly report summary");

    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(["seed", "related"]));
    expect(results.find((r) => r.id === "related")?.expansionReason).toBe("related_source");
  });

  it("returns an empty array when there are no candidates at all", async () => {
    const service = makeService(() => []);
    const results = await service.search("user-1", "anything");
    expect(results).toEqual([]);
  });

  it("hasEvidence only counts seed chunks that clear the minimum similarity threshold", async () => {
    const service = makeService(() => []);
    const weakSeed = { id: "a", semanticScore: 0.01, expansionReason: "seed" as const } as never;
    const strongExpansion = { id: "b", semanticScore: 0.99, expansionReason: "sibling" as const } as never;
    expect(service.hasEvidence([weakSeed, strongExpansion])).toBe(false);
  });
});
