import { Injectable, Logger, Optional } from "@nestjs/common";
import { FinancialEngineService } from "../financial-engine/financial-engine.service";
import { PrismaService } from "../../prisma/prisma.service";
import { QueryRewriteService } from "./retrieval/query-rewrite.service";
import { HybridRetrievalService, QueryContext, ScoredChunk, SearchFilters, mergeCandidatePools, suppressNearDuplicates } from "./retrieval/hybrid-retrieval.service";
import { RerankedChunk, RerankingService } from "./retrieval/reranking.service";
import { AnswerSynthesisService } from "./synthesis/answer-synthesis.service";
import { CITATION_CONFIDENCE_BANDS, TOP_K_RERANKED, adaptiveRerankLimit, QueryComplexity, QueryType } from "./rag.constants";
import { QueryUnderstanding, normalizeForRetrieval, understandQuery } from "./retrieval/query-understanding";

/** What the search could and could not establish. "unverified" means evidence was found but the
 * AI-composed answer could not be checked against it, so only the citations are trustworthy. */
export type EvidenceSufficiency = "sufficient" | "partial" | "insufficient" | "unverified" | "needs_clarification";

const CLARIFICATION_ANSWER =
  "I can't tell what to look up from that. Ask a self-contained question that names the subject — for example “What is my home loan EMI?” or “What did I spend on groceries in September 2026?” — rather than a follow-up like “what about it?”.";

const MAX_SEARCH_PHRASINGS = 5;

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
  /** Set when the question is about the user's own numbers and the deterministic finance engine answered
   * it from the live records (not from the index, which can lag behind recent edits). The figures in
   * `answer` that come from here were verified against the same backend facts the dashboard uses. */
  liveAnswer?: { intent: string; answer: string; tools: string[] };
  /** Which retrieval signals were available: "hybrid" (semantic + keyword) or "lexical" (the vector model
   * was unavailable and ranking used keyword/recency/priority only). */
  retrievalMode?: "hybrid" | "lexical";
  /** Wall-clock stage timings in milliseconds, for observability. */
  timingsMs?: { plan: number; retrieve: number; rerank: number; synthesize: number; total: number };
  /** What was read from the question itself (intent, explicit period / amount, exclusions). Reported
   * for transparency; none of it is used to silently remove evidence. */
  understanding?: Pick<QueryUnderstanding, "intent" | "lookupKind" | "dateRange" | "amount" | "negations" | "documentTypeHints">;
  evidenceSufficiency?: EvidenceSufficiency;
}

@Injectable()
export class RagService {
  private readonly logger = new Logger(RagService.name);

  constructor(
    private prisma: PrismaService,
    private queryRewrite: QueryRewriteService,
    private retrieval: HybridRetrievalService,
    private reranking: RerankingService,
    private synthesis: AnswerSynthesisService,
    // Optional so existing call sites and tests that build RagService by hand keep working.
    @Optional() private engine?: FinancialEngineService,
  ) {}

  /** The deterministic finance engine's answer for questions about the user's own numbers (net worth,
   * insurance premiums, loans, spending, income, investments, emergency fund). Never throws: a failure
   * just means the answer comes from retrieval alone. */
  private async tryLiveAnswer(userId: string, query: string): Promise<{ intent: string; answer: string; tools: string[] } | null> {
    if (!this.engine) return null;
    try {
      const res = await this.engine.ask(userId, query);
      if (!res.handled || !res.answer) return null;
      return { intent: res.intent, answer: res.answer, tools: res.tools.map((t) => t.tool) };
    } catch (err) {
      this.logger.warn(`Live finance answer unavailable for search: ${(err as Error).name}`);
      return null;
    }
  }

  async search(userId: string, query: string, filters: SearchFilters = {}): Promise<RagSearchResult> {
    const t0 = Date.now();
    const understanding = understandQuery(query);
    if (understanding.needsClarification) {
      return this.clarificationResult(userId, query, understanding, t0);
    }
    // Deterministic live answer runs alongside planning: it needs no model and no index.
    // A question about what a DOCUMENT says ("what does my loan agreement say about prepayment") is not
    // answered by the live figures for the loan it mentions — leading with the EMI would answer a question
    // nobody asked. Those questions rely on retrieval alone.
    const wantsLive = understanding.intent !== "documents";
    const [plan, live] = await Promise.all([this.queryRewrite.plan(userId, query), wantsLive ? this.tryLiveAnswer(userId, query) : Promise.resolve(null)]);
    const tPlan = Date.now();

    // Multi-hop: run retrieval once per sub-question (falling back to the rewritten
    // queries for a single-hop question) and merge candidate pools before reranking —
    // this is what lets a compound question like "compare this month to last month
    // and tell me if I'm on track for my goals" pull evidence for each part rather
    // than one retrieval pass trying to cover all of it at once.
    const baseQueries = plan.isMultiHop && plan.subQuestions.length > 0 ? plan.subQuestions : plan.rewrittenQueries;
    const searchQueries = buildSearchQueries(baseQueries, query);
    const queryContext: QueryContext = { queryType: plan.queryType, complexity: plan.complexity, boostSourceTypes: understanding.explicitSourceTypes };

    // Read the user's chunk rows ONCE and score every phrasing / sub-question against them, instead of
    // re-reading the whole table per phrasing. Skipped for a single query (nothing to share) and for
    // retrieval doubles that do not expose loadCandidates.
    if (searchQueries.length > 1 && typeof this.retrieval.loadCandidates === "function") {
      queryContext.candidates = await this.retrieval.loadCandidates(userId, filters);
    }

    // An empty candidate set means the user has NO indexed content for this search (index never built,
    // cleared, or every document lacks extracted text) — different from "indexed but nothing matched".
    const indexEmpty = queryContext.candidates !== undefined && queryContext.candidates.length === 0;

    // A question about what an uploaded document says, while no DOCUMENT chunk exists at all: the index
    // holds the user's records but not their upload (OCR not finished / failed, or not reindexed yet).
    // Different from "indexed but nothing matched", and invisible otherwise — the user just saw "no evidence".
    const asksAboutDocuments = understanding.intent === "documents" || understanding.explicitSourceTypes.includes("DOCUMENT");
    const documentsSearchable = !filters.sourceTypes?.length || filters.sourceTypes.includes("DOCUMENT");
    const documentChunkCount = queryContext.candidates?.filter((c) => c.sourceType === "DOCUMENT").length;
    const noDocumentsIndexed = asksAboutDocuments && documentsSearchable && documentChunkCount === 0 && !indexEmpty;

    const candidatePools = await Promise.all(
      searchQueries.map((q) => this.retrieval.search(userId, q, filters, queryContext)),
    );
    const candidateCount = candidatePools.reduce((n, pool) => n + pool.length, 0);
    // Exact-id dedup first (a chunk retrieved by two different sub-question/rewritten-
    // phrasing passes keeps only its best score), then near-duplicate suppression
    // across the MERGED pool — two sub-questions can each surface a different chunk
    // that says essentially the same thing (e.g. a Report and a Snapshot both
    // restating this month's savings rate), which per-query suppression inside
    // HybridRetrievalService.search() can't catch since it only ever sees one
    // sub-query's own pool at a time.
    const merged = suppressNearDuplicates(mergeCandidatePools(candidatePools));
    const tRetrieve = Date.now();

    const hasEvidence = this.retrieval.hasEvidence(merged);
    const explanationParts: string[] = [
      plan.isMultiHop
        ? `This looked like a multi-part question, so it was split into ${searchQueries.length} sub-questions and searched separately.`
        : `Searched using ${searchQueries.length} phrasing${searchQueries.length > 1 ? "s" : ""} of your question to improve recall.`,
    ];

    if (candidateCount === 0) {
      explanationParts.push(
        "Nothing was found in your search index for this question. That usually means the index is empty or out of date, or a source / date filter is hiding everything — clear the filters or use “Reindex my data”.",
      );
    }
    const understandingNote = describeUnderstanding(understanding);
    if (understandingNote) explanationParts.push(understandingNote);
    if (noDocumentsIndexed) {
      explanationParts.push(
        `None of your uploaded documents are in the search index, so this question could not be answered from them. ${await this.describeDocumentStatuses(userId)}`,
      );
    }
    if (indexEmpty) {
      explanationParts.push(
        "Nothing is indexed for your account yet (or the index was cleared), so uploaded documents could not be searched — this answer comes from your live records only. Use “Reindex my data”, and check that your documents finished text extraction.",
      );
    }

    if (!hasEvidence && live) {
      // Nothing in the index matched, but the live records answer the question exactly.
      const result: RagSearchResult = {
        query,
        rewrittenQueries: plan.rewrittenQueries,
        isMultiHop: plan.isMultiHop,
        subQuestions: plan.subQuestions,
        queryType: plan.queryType,
        complexity: plan.complexity,
        hasEvidence: true,
        answer: live.answer,
        citedSources: [],
        retrievalConfidence: 1,
        answerConfidence: 1,
        groundingScore: 1,
        hallucinationRisk: "low",
        explanation: explanationParts.join(" ") + " Answered directly from your live records (verified against the same figures as your dashboard).",
        liveAnswer: live,
        timingsMs: { plan: tPlan - t0, retrieve: tRetrieve - tPlan, rerank: 0, synthesize: 0, total: Date.now() - t0 },
        understanding: publicUnderstanding(understanding),
        evidenceSufficiency: "sufficient",
      };
      this.logSummary(plan, understanding, { candidates: candidateCount, merged: merged.length, cited: 0, mode: "live", result, indexEmpty, documentChunks: documentChunkCount });
      await this.logSearch(userId, query, plan, [], [], result);
      return result;
    }

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
        understanding: publicUnderstanding(understanding),
        evidenceSufficiency: "insufficient",
      };
      this.logSummary(plan, understanding, { candidates: candidateCount, merged: merged.length, cited: 0, mode: "none", result, indexEmpty, documentChunks: documentChunkCount });
      await this.logSearch(userId, query, plan, [], [], result);
      return result;
    }

    // A question about a document is usually answered by several neighbouring passages (a list of covered
    // conditions, a clause and its exceptions); a "simple" question's limit of 3 kept too few of them.
    const rerankLimit = asksAboutDocuments ? Math.max(adaptiveRerankLimit(plan.complexity), TOP_K_RERANKED) : adaptiveRerankLimit(plan.complexity);
    const rerankResult = await this.reranking.rerank(userId, query, merged, rerankLimit);
    const tRerank = Date.now();
    explanationParts.push(
      `${merged.length} candidates were found across sources; the ${rerankResult.chunks.length} most relevant were reranked and kept: ${rerankResult.rationale}`,
    );

    const synthesisResult = await this.synthesis.synthesize(userId, query, rerankResult.chunks);
    const tSynth = Date.now();

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
      hasEvidence: synthesisResult.hasEvidence || Boolean(live),
      // For a question about the user's own numbers, the verified live figures lead; the retrieved,
      // cited detail (documents, reports, history) follows. A degraded synthesis (unavailable / failed
      // grounding: confidence 0) is never appended.
      answer:
        live && synthesisResult.hasEvidence && synthesisResult.confidence > 0
          ? `${live.answer}\n\nFrom your records and documents: ${synthesisResult.answer}`
          : live && (!synthesisResult.hasEvidence || synthesisResult.confidence === 0)
            ? live.answer
            : synthesisResult.answer,
      citedSources,
      retrievalConfidence,
      // The model's self-reported confidence is never shown above the measured grounding of the same answer.
      answerConfidence: capByGrounding(synthesisResult.confidence, synthesisResult.groundingScore),
      groundingScore: synthesisResult.groundingScore,
      hallucinationRisk: synthesisResult.hallucinationRisk,
      explanation: explanationParts.join(" ") + (live ? " The leading figures come from your live records." : ""),
      ...(live ? { liveAnswer: live } : {}),
      retrievalMode: merged.length > 0 && merged.every((c) => c.semanticScore === 0) ? "lexical" : "hybrid",
      timingsMs: { plan: tPlan - t0, retrieve: tRetrieve - tPlan, rerank: tRerank - tRetrieve, synthesize: tSynth - tRerank, total: Date.now() - t0 },
      understanding: publicUnderstanding(understanding),
      evidenceSufficiency: evidenceSufficiencyOf(synthesisResult, Boolean(live)),
    };

    this.logSummary(plan, understanding, { candidates: candidateCount, merged: merged.length, cited: citedSources.length, mode: result.retrievalMode ?? "hybrid", result, documentChunks: documentChunkCount });
    await this.logSearch(userId, query, plan, merged, synthesisResult.citedChunkIds, result);
    return result;
  }

  /** Why uploads are missing from the index, in the user's terms: how many documents exist per extraction
   * status. Only an indexed document has text, and only status DONE produces text. Never throws. */
  private async describeDocumentStatuses(userId: string): Promise<string> {
    const generic = "Check that the document finished text extraction (its status must be done, not pending, failed or not applicable), then use “Reindex my data” and ask again.";
    try {
      const rows = await this.prisma.client.document.groupBy({ by: ["ocrStatus"], where: { userId }, _count: { _all: true } });
      if (rows.length === 0) return "You have no uploaded documents yet. Upload the document first, wait for text extraction to finish, then ask again.";
      const label: Record<string, string> = {
        DONE: "text extracted (will be searchable after “Reindex my data”)",
        PENDING: "still waiting for text extraction",
        FAILED: "text extraction failed (re-upload the file)",
        NOT_APPLICABLE: "no text could be read (unsupported or password-protected file)",
      };
      const parts = rows.map((r) => `${r._count._all} ${label[String(r.ocrStatus)] ?? String(r.ocrStatus).toLowerCase()}`);
      return `Your documents: ${parts.join("; ")}.`;
    } catch {
      return generic;
    }
  }

  private async clarificationResult(userId: string, query: string, understanding: QueryUnderstanding, t0: number): Promise<RagSearchResult> {
    const result: RagSearchResult = {
      query,
      rewrittenQueries: [query],
      isMultiHop: false,
      subQuestions: [],
      queryType: "exploratory",
      complexity: "simple",
      hasEvidence: false,
      answer: CLARIFICATION_ANSWER,
      citedSources: [],
      retrievalConfidence: 0,
      answerConfidence: null,
      groundingScore: null,
      hallucinationRisk: "unmeasured",
      explanation: understanding.clarificationReason ?? "The question names no subject to search for.",
      timingsMs: { plan: 0, retrieve: 0, rerank: 0, synthesize: 0, total: Date.now() - t0 },
      understanding: publicUnderstanding(understanding),
      evidenceSufficiency: "needs_clarification",
    };
    this.logger.log(`ai-search summary ${JSON.stringify({ intent: understanding.intent, outcome: "needs_clarification", totalMs: result.timingsMs?.total })}`);
    await this.logSearch(userId, query, { rewrittenQueries: [query], queryType: "exploratory", complexity: "simple" }, [], [], result);
    return result;
  }

  /** One structured line per search: counts, timings and outcome only — never the question, an answer,
   * a figure, or any record content. */
  private logSummary(
    plan: { planSource?: string; planMeta?: { cacheHit: boolean; retries: number; rejectedPhrasings: number }; queryType: QueryType; complexity: QueryComplexity; isMultiHop: boolean; rewrittenQueries: string[] },
    understanding: QueryUnderstanding,
    stats: { candidates: number; merged: number; cited: number; mode: string; result: RagSearchResult; indexEmpty?: boolean; documentChunks?: number },
  ): void {
    const { result } = stats;
    this.logger.log(
      `ai-search summary ${JSON.stringify({
        intent: understanding.intent,
        lookup: understanding.lookupKind,
        planSource: plan.planSource ?? "unknown",
        queryType: plan.queryType,
        complexity: plan.complexity,
        multiHop: plan.isMultiHop,
        phrasings: plan.rewrittenQueries.length,
        rewriteCacheHit: plan.planMeta?.cacheHit ?? null,
        rewriteRetries: plan.planMeta?.retries ?? null,
        rejectedPhrasings: plan.planMeta?.rejectedPhrasings ?? null,
        strategy: stats.mode,
        indexEmpty: stats.indexEmpty,
        indexedDocumentChunks: stats.documentChunks,
        candidatesRetrieved: stats.candidates,
        afterDedup: stats.merged,
        cited: stats.cited,
        hasEvidence: result.hasEvidence,
        sufficiency: result.evidenceSufficiency,
        grounding: result.groundingScore,
        hallucinationRisk: result.hallucinationRisk,
        ms: result.timingsMs,
      })}`,
    );
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


function publicUnderstanding(u: QueryUnderstanding): NonNullable<RagSearchResult["understanding"]> {
  return {
    intent: u.intent,
    lookupKind: u.lookupKind,
    ...(u.dateRange ? { dateRange: u.dateRange } : {}),
    ...(u.amount ? { amount: u.amount } : {}),
    negations: u.negations,
    documentTypeHints: u.documentTypeHints,
  };
}

/** A sentence stating what was read from the question. It is transparency only: the period, amount and
 * exclusions are not used to remove sources, because an indexed report's date is its index time, not the
 * period it describes — filtering on it would hide valid evidence. */
function describeUnderstanding(u: QueryUnderstanding): string {
  const parts: string[] = [];
  if (u.dateRange) parts.push(`the period “${u.dateRange.matchedText}”`);
  if (u.amount) parts.push(`the amount “${u.amount.matchedText}”`);
  if (u.negations.length > 0) parts.push(`the exclusion${u.negations.length > 1 ? "s" : ""} “${u.negations.join("”, “")}”`);
  if (parts.length === 0) return "";
  return `Read from your question: ${parts.join(", ")}. These guide what is looked for but are not used to hide any source.`;
}

/** The phrasings actually searched: the planned ones plus one normalised phrasing that keeps only what the
 * question is about (ISO months, no comparison/exclusion/source-type words) — see normalizeForRetrieval.
 * Capped so one search never fans out further than MAX_SEARCH_PHRASINGS. */
export function buildSearchQueries(planned: string[], original: string): string[] {
  const base = planned.slice(0, MAX_SEARCH_PHRASINGS);
  const normalized = normalizeForRetrieval(original);
  if (!normalized || base.some((q) => q.toLowerCase() === normalized.toLowerCase())) return base;
  return [...base.slice(0, MAX_SEARCH_PHRASINGS - 1), normalized];
}

function evidenceSufficiencyOf(synthesis: { hasEvidence: boolean; confidence: number; groundingScore: number | null }, hasLive: boolean): EvidenceSufficiency {
  if (!synthesis.hasEvidence) return hasLive ? "sufficient" : "insufficient";
  if (synthesis.confidence === 0 || synthesis.groundingScore === null) return hasLive ? "sufficient" : "unverified";
  return synthesis.groundingScore >= 0.85 ? "sufficient" : "partial";
}

function capByGrounding(confidence: number, grounding: number | null): number {
  return grounding === null ? confidence : Math.min(confidence, grounding);
}
