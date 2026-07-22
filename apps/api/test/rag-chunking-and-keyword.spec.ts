import { ChunkerService } from "../src/ai/rag/chunking/chunker.service";
import { KeywordScorerService } from "../src/ai/rag/retrieval/keyword-scorer.service";

describe("ChunkerService", () => {
  const service = new ChunkerService();

  it("returns no chunks for empty input", () => {
    expect(service.chunk("")).toEqual([]);
    expect(service.chunk("   ")).toEqual([]);
  });

  it("keeps a short text as a single chunk", () => {
    const chunks = service.chunk("This is a short document about a home loan.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].index).toBe(0);
  });

  it("splits long text into multiple chunks along paragraph boundaries", () => {
    const paragraph = Array(40).fill("word").join(" ") + ".";
    const longText = Array(6).fill(paragraph).join("\n\n");
    const chunks = service.chunk(longText, { targetWords: 100, overlapWords: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    // indices should be sequential starting at 0
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("carries word-level overlap between consecutive chunks", () => {
    const paragraph = (n: number) => Array(60).fill(`word${n}`).join(" ") + ".";
    const longText = [paragraph(1), paragraph(2), paragraph(3)].join("\n\n");
    const chunks = service.chunk(longText, { targetWords: 70, overlapWords: 15 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    const firstChunkTail = chunks[0].text.split(/\s+/).slice(-5).join(" ");
    expect(chunks[1].text).toContain(firstChunkTail.split(" ")[0]);
  });
});

describe("KeywordScorerService (BM25)", () => {
  const service = new KeywordScorerService();

  it("scores a document containing the query terms higher than one that doesn't", () => {
    const docs = [
      "my home loan prepayment saved a lot of interest",
      "the weather today is sunny and warm",
    ];
    const scores = service.score("home loan prepayment", docs);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });

  it("returns all zeros when the query has no usable terms", () => {
    const scores = service.score("", ["some document text"]);
    expect(scores).toEqual([0]);
  });

  it("returns all zeros when there are no documents", () => {
    expect(service.score("home loan", [])).toEqual([]);
  });

  it("gives a document mentioning the query term more times a higher score than one mentioning it once, all else equal", () => {
    const docs = [
      "loan loan loan details about the loan repayment schedule for the loan",
      "loan details about a repayment schedule",
    ];
    const scores = service.score("loan", docs);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
});
