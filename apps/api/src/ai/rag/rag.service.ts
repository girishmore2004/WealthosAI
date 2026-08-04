import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QueryRewriteService } from "./retrieval/query-rewrite.service";
import { HybridRetrievalService, ScoredChunk, SearchFilters, suppressNearDuplicates } from "./retrieval/hybrid-retrieval.service";
import { RerankedChunk, RerankingService } from "./retrieval/reranking.service";
import { AnswerSynthesisService } from "./synthesis/answer-synthesis.service";
import { CITATION_CONFIDENCE_BANDS, adaptiveRerankLimit, QueryComplexity, QueryType } from "./rag.constants";

export interface CitedSource {
  chunkId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
  /** Bucketed retrieval+rerank confidence for THIS specific citation — distinct from
   * the search-level retrievalConfidence/answerConfidence, since one weak citation
   * shouldn't be hidden behind an otherwise-strong overall search. See
   * citationConfidence() below. */
  confidence: "high" | "medium" | "low";
}

export interface RagSearchResult {
  query: string;
  rewrittenQueries: string[];
  isMultiHop: boolean;
  subQuestions: string[];
  queryType: QueryType;
  complexity: QueryComplexity;
  hasEvidence: boolean;
  answer: string;
  citedSources: CitedSource[];
  retrievalConfidence: number;
  answerConfidence: number | null;
  /** The gateway's independent numeric-grounding check on the synthesized answer
   * against the retrieved (parent-expanded) evidence — null when it couldn't be
   * scored (e.g. the AI-unavailable degrade path never got a model response to
   * check). See AnswerSynthesisService/GroundingService. */
  groundingScore: number | null;
  hallucinationRisk: "unmeasured" | "low" | "medium" | "high";
  explanation: string;
}

@Injectable()
export class RagService {
  constructor(
    private prisma: PrismaService,
    private queryRewrite: QueryRewriteService,
    private retrieval: HybridRetrievalService,
    private reranking: RerankingService,
    private synthesis: AnswerSynthesisService,
  ) {}

  async search(userId: string, query: string, filters: SearchFilters = {}): Promise<RagSearchResult> {
    const plan = await this.queryRewrite.plan(userId, query);

    // Multi-hop: run retrieval once per sub-question (falling back to the rewritten
    // queries for a single-hop question) and merge candidate pools before reranking —
    // this is what lets a compound question like "compare this month to last month
    // and tell me if I'm on track for my goals" pull evidence for each part rather
    // than one retrieval pass trying to cover all of it at once.
    const searchQueries = plan.isMultiHop && plan.subQuestions.length > 0 ? plan.subQuestions : plan.rewrittenQueries;
    const queryContext = { queryType: plan.queryType, complexity: plan.complexity };

    const candidatePools = await Promise.all(
      searchQueries.map((q) => this.retrieval.search(userId, q, filters, queryContext)),
    );
    // Exact-id dedup first (a chunk retrieved by two different sub-question/rewritten-
    // phrasing passes keeps only its best score), then near-duplicate suppression
    // across the MERGED pool — two sub-questions can each surface a different chunk
    // that says essentially the same thing (e.g. a Report and a Snapshot both
    // restating this month's savings rate), which per-query suppression inside
    // HybridRetrievalService.search() can't catch since it only ever sees one
    // sub-query's own pool at a time.
    const merged = suppressNearDuplicates(dedupeChunks(candidatePools.flat()));

    const hasEvidence = this.retrieval.hasEvidence(merged);
    const explanationParts: string[] = [
      plan.isMultiHop
        ? `This looked like a multi-part question, so it was split into ${searchQueries.length} sub-questions and searched separately.`
        : `Searched using ${searchQueries.length} phrasing${searchQueries.length > 1 ? "s" : ""} of your question to improve recall.`,
    ];

    if (!hasEvidence) {
      const result: RagSearchResult = {
        query,
        rewrittenQueries: plan.rewrittenQueries,
        isMultiHop: plan.isMultiHop,
        subQuestions: plan.subQuestions,
        queryType: plan.queryType,
        complexity: plan.complexity,
        hasEvidence: false,
        answer:
          "I couldn't find anything in your documents, reports, coach history, or alerts that answers this — rather than guess, I'm telling you there's no evidence for it.",
        citedSources: [],
        retrievalConfidence: 0,
        answerConfidence: null,
        groundingScore: null,
        hallucinationRisk: "unmeasured",
        explanation: explanationParts.join(" ") + " None of the results were similar enough to your question to count as real evidence.",
      };
      await this.logSearch(userId, query, plan, [], [], result);
      return result;
    }

    const rerankLimit = adaptiveRerankLimit(plan.complexity);
    const rerankResult = await this.reranking.rerank(userId, query, merged, rerankLimit);
    explanationParts.push(
      `${merged.length} candidates were found across sources; the ${rerankResult.chunks.length} most relevant were reranked and kept: ${rerankResult.rationale}`,
    );

    const synthesisResult = await this.synthesis.synthesize(userId, query, rerankResult.chunks);

    const citedSources: CitedSource[] = rerankResult.chunks
      .filter((c) => synthesisResult.citedChunkIds.includes(c.id))
      .map((c) => ({
        chunkId: c.id,
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        title: typeof c.metadata.title === "string" ? c.metadata.title : c.sourceType,
        snippet: c.text.slice(0, 240),
        score: Number(c.combinedScore.toFixed(3)),
        confidence: citationConfidence(c),
      }));

    // Retrieval confidence combines the top chunk's own semantic similarity with the
    // reranker's self-reported confidence in its ordering — a single number that
    // reflects both "was anything actually similar" and "was the model sure about
    // which of those similar things mattered most".
    const topSemantic = merged[0]?.semanticScore ?? 0;
    const retrievalConfidence = Number(((topSemantic + rerankResult.confidence) / 2).toFixed(3));

    const result: RagSearchResult = {
      query,
      rewrittenQueries: plan.rewrittenQueries,
      isMultiHop: plan.isMultiHop,
      subQuestions: plan.subQuestions,
      queryType: plan.queryType,
      complexity: plan.complexity,
      hasEvidence: synthesisResult.hasEvidence,
      answer: synthesisResult.answer,
      citedSources,
      retrievalConfidence,
      answerConfidence: synthesisResult.confidence,
      groundingScore: synthesisResult.groundingScore,
      hallucinationRisk: synthesisResult.hallucinationRisk,
      explanation: explanationParts.join(" "),
    };

    await this.logSearch(userId, query, plan, merged, synthesisResult.citedChunkIds, result);
    return result;
  }

  private async logSearch(
    userId: string,
    query: string,
    plan: { rewrittenQueries: string[]; queryType: QueryType; complexity: QueryComplexity },
    retrievedChunks: ScoredChunk[],
    citedChunkIds: string[],
    result: RagSearchResult,
  ): Promise<void> {
    try {
      await this.prisma.client.aiSearchLog.create({
        data: {
          userId,
          query,
          rewrittenQueries: plan.rewrittenQueries,
          retrievedChunkIds: retrievedChunks.map((c) => c.id),
          citedChunkIds,
          hadEvidence: result.hasEvidence,
          retrievalConfidence: result.retrievalConfidence,
          answerConfidence: result.answerConfidence,
          answer: result.answer,
          queryType: plan.queryType,
          complexity: plan.complexity,
          groundingScore: result.groundingScore,
          hallucinationRisk: result.hallucinationRisk,
          citationConfidences: result.citedSources.map((c) => ({ chunkId: c.chunkId, confidence: c.confidence })),
        },
      });
    } catch {
      // Same reasoning as AiLoggingService: a logging failure must never fail the
      // search itself. Silently swallowed here rather than logged twice.
    }
  }
}

/** Blends a citation's own hybrid-retrieval combinedScore with how early the (separate,
 * LLM-based) reranker placed it — a chunk that scored well on retrieval AND was
 * ranked first by reranking is much more likely to be genuinely relevant than one
 * that only cleared the hybrid-retrieval bar. Bucketed into high/medium/low rather
 * than shown as a raw float, consistent with how confidence/hallucinationRisk are
 * already surfaced elsewhere in the AI layer (see AiResult.hallucinationRisk). */
function citationConfidence(chunk: RerankedChunk): "high" | "medium" | "low" {
  const positionScore = 1 / (1 + chunk.rerankPosition); // 1, 0.5, 0.33, ...
  const blended = chunk.combinedScore * 0.6 + positionScore * 0.4;
  if (blended >= CITATION_CONFIDENCE_BANDS.high) return "high";
  if (blended >= CITATION_CONFIDENCE_BANDS.medium) return "medium";
  return "low";
}

function dedupeChunks(chunks: ScoredChunk[]): ScoredChunk[] {
  const byId = new Map<string, ScoredChunk>();
  for (const chunk of chunks) {
    const existing = byId.get(chunk.id);
    if (!existing || chunk.combinedScore > existing.combinedScore) {
      byId.set(chunk.id, chunk);
    }
  }
  return [...byId.values()].sort((a, b) => b.combinedScore - a.combinedScore);
}
