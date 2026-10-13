// The real PrismaService pulls in the generated client, which tries to load a native query engine when
// nothing here needs a database. Every test below uses hand-built doubles.
jest.mock("../src/prisma/prisma.service", () => ({ PrismaService: class PrismaService {} }));

import { HybridRetrievalService, mergeCandidatePools, suppressNearDuplicates } from "../src/ai/rag/retrieval/hybrid-retrieval.service";
import { KeywordScorerService } from "../src/ai/rag/retrieval/keyword-scorer.service";
import { heuristicPlanFields, understandQuery } from "../src/ai/rag/retrieval/query-understanding";
import { withDeterministicPhrasings } from "../src/ai/rag/retrieval/query-rewrite.service";
import { buildSearchQueries } from "../src/ai/rag/rag.service";
import evalSet from "./fixtures/ai-search-eval-set.json";

// Deterministic evaluation of the parts of AI Search that do not need a model: query understanding and
// lexical hybrid retrieval over a SYNTHETIC corpus (see the fixture). The embedding backend is forced
// to fail so ranking is lexical (BM25 + recency + priority) — the documented degrade path — which keeps
// the run reproducible. Answer-text expectations in the fixture ("expectedAnswerBehavior") describe what a
// live, model-backed run must satisfy; they are not asserted here because no model is called.

interface CorpusItem { id: string; sourceType: string; title: string; text: string }
interface EvalQuestion {
  id: string;
  question: string;
  expectedIntent: string | string[];
  expectedLookup: "exact" | "analytical";
  expectEvidence: boolean;
  expectedTopSourceIds?: string[];
  expectedEvidenceType?: string;
  expectedDateRange?: { from: string; to: string };
  expectedAmount?: { min?: number; max?: number; exact?: number };
  expectedNegations?: string[];
  expectClarification?: boolean;
  expectedAnswerBehavior: string;
}

const USER = "user-eval";
const corpus = evalSet.corpus as CorpusItem[];
const questions = evalSet.questions as EvalQuestion[];
const NOW = new Date("2026-10-12T00:00:00Z");

function rows(userId: string) {
  return corpus.map((c, i) => ({
    id: `chunk-${c.id}`,
    userId,
    sourceType: c.sourceType,
    sourceId: c.id,
    chunkIndex: 0,
    text: c.text,
    parentText: c.text,
    metadata: { title: c.title },
    embedding: [],
    embeddingModelVersion: 1,
    sourcePriority: c.sourceType === "ALERT" ? 1 : c.sourceType === "COACH_INTERACTION" || c.sourceType === "SNAPSHOT" ? 2 : 3,
    sourceCreatedAt: new Date("2026-10-01T00:00:00Z"),
    relatedSourceIds: [],
    tokenCount: Math.ceil(c.text.length / 4) + i * 0,
  }));
}

function buildRetrieval() {
  const store = rows(USER);
  const prisma = {
    client: {
      aiEmbeddingChunk: {
        findMany: jest.fn(async ({ where }: { where: { userId: string; sourceId?: { in: string[] }; sourceType?: { in: string[] } } }) =>
          store.filter(
            (r) =>
              r.userId === where.userId &&
              (!where.sourceId || where.sourceId.in.includes(r.sourceId)) &&
              (!where.sourceType || where.sourceType.in.includes(r.sourceType)),
          ),
        ),
      },
    },
  };
  const embedding = { embedWithVersion: jest.fn().mockRejectedValue(new Error("embedding backend unavailable")) };
  return new HybridRetrievalService(prisma as never, embedding as never, new KeywordScorerService());
}

describe("AI Search evaluation set", () => {
  it("contains at least 20 questions, each with expected evidence type and answer behaviour", () => {
    expect(questions.length).toBeGreaterThanOrEqual(20);
    for (const q of questions) {
      expect(q.expectedAnswerBehavior.length).toBeGreaterThan(10);
      if (q.expectEvidence) {
        expect(q.expectedTopSourceIds?.length).toBeGreaterThan(0);
        expect(q.expectedEvidenceType).toBeTruthy();
      }
    }
    expect(questions.filter((q) => !q.expectEvidence).length).toBeGreaterThanOrEqual(3); // failure-behaviour cases
  });

  describe.each(questions.map((q) => [q.id, q] as const))("%s", (_id, q) => {
    it("is understood as expected", () => {
      const u = understandQuery(q.question, NOW);
      const intents = Array.isArray(q.expectedIntent) ? q.expectedIntent : [q.expectedIntent];
      expect(intents).toContain(u.intent);
      expect(u.lookupKind).toBe(q.expectedLookup);
      expect(u.needsClarification).toBe(Boolean(q.expectClarification));
      if (q.expectedDateRange) expect(u.dateRange).toMatchObject(q.expectedDateRange);
      else expect(u.dateRange).toBeUndefined();
      if (q.expectedAmount) expect(u.amount).toMatchObject(q.expectedAmount);
      if (q.expectedNegations) expect(u.negations).toEqual(q.expectedNegations);
      // The local plan never leaves a classifiable question as an unclassified blob.
      expect(heuristicPlanFields(q.question, u).complexity).toBeDefined();
    });

    it("retrieves the expected evidence — or none", async () => {
      if (q.expectClarification) return; // short-circuits before retrieval; covered in the pipeline spec
      const retrieval = buildRetrieval();
      const u = understandQuery(q.question, NOW);
      const plan = heuristicPlanFields(q.question, u);
      // Same phrasings and context RagService builds when the model rewrite is unavailable.
      const queries = buildSearchQueries(withDeterministicPhrasings(q.question, []), q.question);
      const pools = await Promise.all(queries.map((query) => retrieval.search(USER, query, {}, { ...plan, boostSourceTypes: u.explicitSourceTypes })));
      const results = suppressNearDuplicates(mergeCandidatePools(pools));
      const hasEvidence = retrieval.hasEvidence(results);

      expect(hasEvidence).toBe(q.expectEvidence);
      if (q.expectEvidence) {
        const topIds = results.slice(0, 3).map((r) => r.sourceId);
        expect(q.expectedTopSourceIds!.some((id) => topIds.includes(id))).toBe(true);
      }
    });
  });

  it("never returns another user's chunks, whatever the question", async () => {
    const retrieval = buildRetrieval();
    for (const q of questions.filter((x) => !x.expectClarification)) {
      const results = await retrieval.search("someone-else", q.question, {}, {});
      expect(results).toEqual([]);
    }
  });
});
