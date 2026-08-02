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

  // Regression test: the sentence-splitting regex used for oversized paragraphs
  // previously only matched text ending in . ! or ? — any trailing fragment without
  // terminal punctuation (very common in OCR'd statement text, or any paragraph that's
  // simply cut off) was silently dropped and never made it into any chunk, meaning it
  // was never embedded or searchable even though it existed in the source document.
  it("preserves a trailing sentence fragment that has no terminal punctuation, inside an oversized paragraph", () => {
    const filler = Array(200).fill("word").join(" ");
    const longParagraph = `First sentence here. ${filler} this trailing fragment has no period at the end`;
    const chunks = service.chunk(longParagraph, { targetWords: 100, overlapWords: 10 });
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(rejoined).toContain("this trailing fragment has no period at the end");
  });

  // Regression test: a paragraph made ENTIRELY of one long fragment with no terminal
  // punctuation anywhere at all must still survive chunking rather than being dropped.
  it("preserves an oversized paragraph that has no terminal punctuation anywhere", () => {
    const noPunctuation = Array(200).fill("word").join(" ") + " with absolutely no punctuation to be found here at all";
    const chunks = service.chunk(noPunctuation, { targetWords: 100, overlapWords: 10 });
    const rejoined = chunks.map((c) => c.text).join(" ");
    expect(rejoined).toContain("with absolutely no punctuation to be found here at all");
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
