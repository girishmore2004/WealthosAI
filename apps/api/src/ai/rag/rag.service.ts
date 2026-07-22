import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { QueryRewriteService } from "./retrieval/query-rewrite.service";
import { HybridRetrievalService, ScoredChunk, SearchFilters } from "./retrieval/hybrid-retrieval.service";
import { RerankingService } from "./retrieval/reranking.service";
import { AnswerSynthesisService } from "./synthesis/answer-synthesis.service";

export interface CitedSource {
  chunkId: string;
  sourceType: string;
  sourceId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface RagSearchResult {
  query: string;
  rewrittenQueries: string[];
  isMultiHop: boolean;
  subQuestions: string[];
  hasEvidence: boolean;
  answer: string;
  citedSources: CitedSource[];
  retrievalConfidence: number;
  answerConfidence: number | null;
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

    const candidatePools = await Promise.all(searchQueries.map((q) => this.retrieval.search(userId, q, filters)));
    const merged = dedupeChunks(candidatePools.flat());

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
        hasEvidence: false,
        answer:
          "I couldn't find anything in your documents, reports, coach history, or alerts that answers this — rather than guess, I'm telling you there's no evidence for it.",
        citedSources: [],
        retrievalConfidence: 0,
        answerConfidence: null,
        explanation: explanationParts.join(" ") + " None of the results were similar enough to your question to count as real evidence.",
      };
      await this.logSearch(userId, query, plan.rewrittenQueries, [], [], result);
      return result;
    }

    const rerankResult = await this.reranking.rerank(userId, query, merged);
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
      hasEvidence: synthesisResult.hasEvidence,
      answer: synthesisResult.answer,
      citedSources,
      retrievalConfidence,
      answerConfidence: synthesisResult.confidence,
      explanation: explanationParts.join(" "),
    };

    await this.logSearch(userId, query, plan.rewrittenQueries, merged, synthesisResult.citedChunkIds, result);
    return result;
  }

  private async logSearch(
    userId: string,
    query: string,
    rewrittenQueries: string[],
    retrievedChunks: ScoredChunk[],
    citedChunkIds: string[],
    result: RagSearchResult,
  ): Promise<void> {
    try {
      await this.prisma.client.aiSearchLog.create({
        data: {
          userId,
          query,
          rewrittenQueries,
          retrievedChunkIds: retrievedChunks.map((c) => c.id),
          citedChunkIds,
          hadEvidence: result.hasEvidence,
          retrievalConfidence: result.retrievalConfidence,
          answerConfidence: result.answerConfidence,
          answer: result.answer,
        },
      });
    } catch {
      // Same reasoning as AiLoggingService: a logging failure must never fail the
      // search itself. Silently swallowed here rather than logged twice.
    }
  }
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
