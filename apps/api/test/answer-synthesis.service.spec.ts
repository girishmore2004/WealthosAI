import { AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";
import { AiUnavailableException, AiValidationException } from "../src/ai/exceptions/ai.exceptions";
import { RerankedChunk } from "../src/ai/rag/retrieval/reranking.service";

function makeRerankedChunk(id: string): RerankedChunk {
  return {
    id,
    sourceType: "DOCUMENT",
    sourceId: `src-${id}`,
    text: `some source text for ${id}`,
    metadata: {},
    sourceCreatedAt: new Date(),
    semanticScore: 0.8,
    keywordScore: 0.5,
    recencyScore: 0.5,
    priorityScore: 0.5,
    combinedScore: 0.8,
    rerankPosition: 0,
  };
}

describe("AnswerSynthesisService.synthesize", () => {
  it("returns the no-evidence answer without calling the gateway when there are no chunks", async () => {
    const mockGateway = { extract: jest.fn() };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "what's my loan balance", []);

    expect(result.hasEvidence).toBe(false);
    expect(result.citedChunkIds).toEqual([]);
    expect(mockGateway.extract).not.toHaveBeenCalled();
  });

  it("composes a grounded answer and returns cited chunk ids when the model responds normally", async () => {
    const chunks = [makeRerankedChunk("a"), makeRerankedChunk("b")];
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { hasEvidence: true, answer: "Your loan balance is X.", citedIndices: [0] },
        confidence: 0.9,
      }),
    };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "what's my loan balance", chunks);

    expect(result.hasEvidence).toBe(true);
    expect(result.answer).toBe("Your loan balance is X.");
    expect(result.citedChunkIds).toEqual(["a"]);
    expect(result.confidence).toBe(0.9);
  });

  it("falls back to citing every chunk when the model claims evidence but cites nothing", async () => {
    const chunks = [makeRerankedChunk("a"), makeRerankedChunk("b")];
    const mockGateway = {
      extract: jest.fn().mockResolvedValue({
        data: { hasEvidence: true, answer: "Some answer.", citedIndices: [] },
        confidence: 0.6,
      }),
    };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "question", chunks);

    expect(result.citedChunkIds).toEqual(["a", "b"]);
  });

  // Regression test: previously synthesize() had no try/catch around gateway.extract()
  // at all — an AiUnavailableException (Groq down/timeout) propagated straight past
  // RagService and RagController uncaught, surfacing as a raw 503 and discarding the
  // retrieval + reranking work already done for this request, even though real
  // evidence chunks existed. This is the one AI call in the RAG pipeline that broke the
  // otherwise-consistent "gateway failures degrade gracefully" pattern used everywhere
  // else in the app.
  it("degrades gracefully — without throwing — when the gateway is unavailable, and still surfaces the real chunks found", async () => {
    const chunks = [makeRerankedChunk("a"), makeRerankedChunk("b")];
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiUnavailableException("HTTP 503 from Groq")) };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "what's my loan balance", chunks);

    expect(result.hasEvidence).toBe(true); // NOT "no evidence" — evidence genuinely was retrieved
    expect(result.answer).toMatch(/temporarily unavailable/i);
    expect(result.answer).not.toContain("I couldn't find anything"); // must not reuse the no-evidence message
    expect(result.citedChunkIds).toEqual(["a", "b"]); // surfaces what was actually found
    expect(result.confidence).toBe(0);
  });

  it("degrades gracefully when the gateway throws AiValidationException (model never returned valid JSON)", async () => {
    const chunks = [makeRerankedChunk("a")];
    const mockGateway = { extract: jest.fn().mockRejectedValue(new AiValidationException("rag.synthesis", 2)) };
    const service = new AnswerSynthesisService(mockGateway as never);

    const result = await service.synthesize("user-1", "question", chunks);

    expect(result.hasEvidence).toBe(true);
    expect(result.citedChunkIds).toEqual(["a"]);
  });

  it("still propagates an unrelated/unexpected error rather than masking it as an AI-unavailable state", async () => {
    const chunks = [makeRerankedChunk("a")];
    const unexpected = new TypeError("something genuinely broke");
    const mockGateway = { extract: jest.fn().mockRejectedValue(unexpected) };
    const service = new AnswerSynthesisService(mockGateway as never);

    await expect(service.synthesize("user-1", "question", chunks)).rejects.toBe(unexpected);
  });
});
