import { AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";
import { AiGroundingException, AiUnavailableException } from "../src/ai/exceptions/ai.exceptions";
import { RerankedChunk } from "../src/ai/rag/retrieval/reranking.service";

function makeRerankedChunk(id: string, text: string, parentText: string): RerankedChunk {
  return {
    id,
    sourceType: "DOCUMENT",
    sourceId: `src-${id}`,
    chunkIndex: 0,
    text,
    parentText,
    metadata: { title: `Doc ${id}` },
    sourceCreatedAt: new Date("2026-07-01"),
    semanticScore: 0.8,
    keywordScore: 0.5,
    recencyScore: 0.5,
    priorityScore: 1,
    combinedScore: 0.7,
    relatedSourceIds: [],
    expansionReason: "seed",
    rerankPosition: 0,
  };
}

describe("AnswerSynthesisService", () => {
  it("passes groundingContext built from parentText and rejectOnLowGrounding to the gateway", async () => {
    const chunk = makeRerankedChunk("a", "loan balance section", "Full statement: your home loan balance is 45 lakh as of July 2026.");
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { hasEvidence: true, answer: "Your loan balance is 45 lakh.", citedIndices: [0] },
        confidence: 0.9,
        groundingScore: 0.95,
        hallucinationRisk: "low",
      }),
    };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "what's my loan balance", [chunk]);

    expect(mockGateway.extract).toHaveBeenCalledWith(
      expect.any(String),
      expect.anything(),
      expect.objectContaining({
        groundingContext: expect.stringContaining("45 lakh"),
        rejectOnLowGrounding: true,
      }),
    );
    expect(result.answer).toBe("Your loan balance is 45 lakh.");
    expect(result.groundingScore).toBe(0.95);
    expect(result.hallucinationRisk).toBe("low");
  });

  it("dedupes parentText per source when building groundingContext across multiple chunks from the same source", async () => {
    const chunkA = makeRerankedChunk("a", "part one", "Shared parent text for source X");
    const chunkB = { ...makeRerankedChunk("b", "part two", "Shared parent text for source X"), sourceId: chunkA.sourceId, rerankPosition: 1 };
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { hasEvidence: true, answer: "answer", citedIndices: [0, 1] },
        confidence: 0.8,
        groundingScore: 0.8,
        hallucinationRisk: "low",
      }),
    };
    const service = new AnswerSynthesisService(mockGateway as never);

    await service.synthesize("user-1", "question", [chunkA, chunkB]);

    const [, , options] = mockGateway.extract.mock.calls[0];
    const occurrences = (options.groundingContext.match(/Shared parent text for source X/g) ?? []).length;
    expect(occurrences).toBe(1);
  });

  it("degrades gracefully with a real-evidence message when grounding verification fails", async () => {
    const chunk = makeRerankedChunk("a", "text", "parent text");
    const mockGateway = {
      extract: jest.fn().mockRejectedValue(new AiGroundingException("rag.synthesis", ["99 lakh"])),
    };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "question", [chunk]);

    expect(result.hasEvidence).toBe(true);
    expect(result.hallucinationRisk).toBe("high");
    expect(result.confidence).toBe(0);
    expect(result.citedChunkIds).toEqual(["a"]);
  });

  it("degrades gracefully when the gateway is unavailable, still surfacing retrieved evidence", async () => {
    const chunk = makeRerankedChunk("a", "text", "parent text");
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiUnavailableException("groq down")) };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "question", [chunk]);

    expect(result.hasEvidence).toBe(true);
    expect(result.groundingScore).toBeNull();
    expect(result.citedChunkIds).toEqual(["a"]);
  });

  it("returns the no-evidence answer without calling the gateway when there are no chunks", async () => {
    const mockGateway = { extract: jest.fn() };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "question", []);

    expect(result.hasEvidence).toBe(false);
    expect(mockGateway.extract).not.toHaveBeenCalled();
  });
});
