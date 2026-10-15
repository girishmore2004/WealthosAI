import { RagService, composeAnswer, formatLiveAnswer, remapCitationMarkers } from "../src/ai/rag/rag.service";
import { ANSWER_FORMAT_INSTRUCTIONS, AnswerSynthesisService } from "../src/ai/rag/synthesis/answer-synthesis.service";

const LIVE_INSURANCE =
  "You have 3 policies with ₹4,070 in premiums recorded so far. Star Health (Girish Policy) health: ₹741 premium; Star health (Parent Group policy) health: ₹3,329 premium; Star Health (Jayant Policy) health: ₹747 premium. Heads up: Data check: A linked document shows a different value from your records. Your records were not changed; review the difference.";

describe("formatLiveAnswer", () => {
  it("lays a list-and-note answer out as summary, one bullet per item and a highlighted note", () => {
    const out = formatLiveAnswer(LIVE_INSURANCE);
    expect(out).toBe(
      [
        "You have 3 policies with ₹4,070 in premiums recorded so far.",
        "- **Star Health (Girish Policy) health:** ₹741 premium\n- **Star health (Parent Group policy) health:** ₹3,329 premium\n- **Star Health (Jayant Policy) health:** ₹747 premium",
        "**Heads up:** Data check: A linked document shows a different value from your records. Your records were not changed; review the difference.",
      ].join("\n\n"),
    );
  });

  it("never changes the words or figures, only the layout", () => {
    const strip = (s: string) => s.replace(/[*\-\s;.]+/g, "").replace(/Headsup:/g, "");
    expect(strip(formatLiveAnswer(LIVE_INSURANCE))).toBe(strip(LIVE_INSURANCE));
  });

  it("returns text that has neither a list nor a note unchanged", () => {
    const plain = "Your net worth is ₹12,40,000 as of 2026-09-30; it grew from the previous month.";
    expect(formatLiveAnswer(plain)).toBe(plain);
  });

  it("does not turn a semicolon sentence into bullets unless every part is a 'label: value' pair", () => {
    const text = "Your EMI is ₹21,000; the loan ends in 2031.";
    expect(formatLiveAnswer(text)).toBe(text);
  });

  it("handles an empty string", () => {
    expect(formatLiveAnswer("   ")).toBe("");
  });
});

describe("composeAnswer", () => {
  const live = { answer: "Your EMI is ₹21,000." };

  it("uses the document answer alone when there is no live answer", () => {
    expect(composeAnswer(null, { hasEvidence: true, confidence: 0.9, answer: "Doc says X." })).toBe("Doc says X.");
  });

  it("puts both under labelled headings when each contributed", () => {
    const out = composeAnswer(live, { hasEvidence: true, confidence: 0.9, answer: "Doc says X." });
    expect(out).toBe("**From your records**\nYour EMI is ₹21,000.\n\n**From your documents**\nDoc says X.");
  });

  it("never appends a degraded document answer (confidence 0) to a live answer", () => {
    expect(composeAnswer(live, { hasEvidence: true, confidence: 0, answer: "AI unavailable." })).toBe("Your EMI is ₹21,000.");
  });

  it("uses the live answer alone when the documents had no evidence", () => {
    expect(composeAnswer(live, { hasEvidence: false, confidence: 1, answer: "none" })).toBe("Your EMI is ₹21,000.");
  });
});

describe("remapCitationMarkers", () => {
  const reranked = [{ id: "c0" }, { id: "c1" }, { id: "c2" }];

  it("renumbers markers to the position of the source in the cited list", () => {
    const cited = [{ chunkId: "c1" }, { chunkId: "c2" }];
    expect(remapCitationMarkers("Premium is ₹8,126 [1]. Period is 1 year [2].", reranked, cited)).toBe(
      "Premium is ₹8,126 [1]. Period is 1 year [2].",
    );
    expect(remapCitationMarkers("Coverage ₹20,00,000 [2]; premium ₹3,329 [1].", reranked, cited)).toBe("Coverage ₹20,00,000 [2]; premium ₹3,329 [1].");
  });

  it("maps list indexes, not cited positions: source 2 in the model's list becomes card 1 when only it is cited", () => {
    expect(remapCitationMarkers("Total premium Rs. 36,498 [2].", reranked, [{ chunkId: "c2" }])).toBe("Total premium Rs. 36,498 [1].");
  });

  it("drops a marker for a source that is not in the cited list", () => {
    expect(remapCitationMarkers("Fact A [0]. Fact B [1].", reranked, [{ chunkId: "c1" }])).toBe("Fact A. Fact B [1].");
  });

  it("leaves text without markers alone", () => {
    expect(remapCitationMarkers("No markers here.", reranked, [])).toBe("No markers here.");
  });
});

describe("AnswerSynthesisService input format", () => {
  it("tells the model how to lay the answer out, before the sources so trimming never removes it", async () => {
    const chunk = {
      id: "a",
      sourceType: "DOCUMENT" as const,
      sourceId: "src-a",
      chunkIndex: 0,
      text: "Total Premium Rs. 36,498",
      parentText: "Total Premium Rs. 36,498",
      metadata: {},
      sourceCreatedAt: new Date(),
      semanticScore: 0.8,
      keywordScore: 0.5,
      recencyScore: 0.5,
      priorityScore: 0.5,
      combinedScore: 0.8,
      relatedSourceIds: [],
      expansionReason: "seed" as const,
      rerankPosition: 0,
    };
    const extract = jest.fn().mockResolvedValue({
      data: { hasEvidence: true, answer: "ok", citedIndices: [0] },
      confidence: 0.9,
      groundingScore: 1,
      hallucinationRisk: "low",
    });
    await new AnswerSynthesisService({ extract } as never).synthesize("user-1", "what is my premium", [chunk]);

    const input = extract.mock.calls[0][0] as string;
    expect(input).toContain(ANSWER_FORMAT_INSTRUCTIONS);
    expect(input.indexOf(ANSWER_FORMAT_INSTRUCTIONS)).toBeLessThan(input.indexOf("Numbered sources"));
    expect(ANSWER_FORMAT_INSTRUCTIONS).toContain("**Key details**");
    expect(ANSWER_FORMAT_INSTRUCTIONS).toMatch(/no numbered lists/);
  });
});

describe("RagService starts reading the user's chunk rows while the query is still being planned", () => {
  it("calls loadCandidates before the plan resolves, and hands the rows to retrieval", async () => {
    let planResolved = false;
    const rows = [{ id: "r1", sourceType: "REPORT" }];
    const queryRewrite = {
      plan: jest.fn(
        () =>
          new Promise((resolve) =>
            setTimeout(() => {
              planResolved = true;
              resolve({ originalQuery: "q", rewrittenQueries: ["q"], isMultiHop: false, subQuestions: [], queryType: "exploratory", complexity: "moderate" });
            }, 25),
          ),
      ),
    };
    let loadedBeforePlan: boolean | undefined;
    const retrieval = {
      loadCandidates: jest.fn(async () => {
        loadedBeforePlan = !planResolved;
        return rows;
      }),
      search: jest.fn().mockResolvedValue([]),
      hasEvidence: jest.fn().mockReturnValue(false),
    };
    const prisma = { client: { aiSearchLog: { create: jest.fn().mockResolvedValue({}) } } };

    const service = new RagService(prisma as never, queryRewrite as never, retrieval as never, { rerank: jest.fn() } as never, { synthesize: jest.fn() } as never);
    await service.search("user-1", "what is my insurance premium");

    expect(retrieval.loadCandidates).toHaveBeenCalledTimes(1);
    expect(loadedBeforePlan).toBe(true);
    expect(retrieval.search).toHaveBeenCalledWith("user-1", expect.any(String), {}, expect.objectContaining({ candidates: rows }));
  });

  it("does not leave an unhandled rejection when the early read fails", async () => {
    const queryRewrite = {
      plan: jest.fn().mockResolvedValue({ originalQuery: "q", rewrittenQueries: ["q"], isMultiHop: false, subQuestions: [], queryType: "exploratory", complexity: "moderate" }),
    };
    const retrieval = {
      loadCandidates: jest.fn().mockRejectedValue(new Error("db down")),
      search: jest.fn(),
      hasEvidence: jest.fn(),
    };
    const prisma = { client: { aiSearchLog: { create: jest.fn().mockResolvedValue({}) } } };
    const service = new RagService(prisma as never, queryRewrite as never, retrieval as never, { rerank: jest.fn() } as never, { synthesize: jest.fn() } as never);

    await expect(service.search("user-1", "what is my insurance premium")).rejects.toThrow("db down");
  });
});
