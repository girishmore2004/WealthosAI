import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { QueryComplexity, QueryType, RAG_STAGE_TIMEOUTS_MS, REWRITE_MAX_CORRECTIVE_RETRIES } from "../rag.constants";
import { contentTerms, expansionTerms } from "./keyword-scorer.service";
import {
  QueryUnderstanding,
  heuristicPlanFields,
  introducesNoNewFigures,
  rewritePreservesMeaning,
  understandQuery,
} from "./query-understanding";
import { withStageTimeout } from "../stage-timeout";

const rewriteSchema = z.object({
  // Alternate phrasings of the same question — improves recall against chunk text
  // that doesn't share the user's exact wording (e.g. "how's my debt" vs. "what do I
  // owe" vs. "loan balance").
  // A model that returns a 4th phrasing should not discard the whole rewrite: keeping the first three
  // phrasings preserves meaning (they are alternates of the same question).
  rewrittenQueries: z.preprocess((v) => (Array.isArray(v) ? v.slice(0, 3) : v), z.array(z.string()).min(1).max(3)),

  // True when the question genuinely bundles more than one thing that would each need
  // their own retrieval pass to answer well.
  isMultiHop: z.boolean(),

  subQuestions: z.preprocess((v) => (Array.isArray(v) ? v.slice(0, 4) : v), z.array(z.string()).max(4)),

  // Drives HybridRetrievalService's per-query-type weight profile.
  queryType: z.enum(["factual", "comparative", "analytical", "exploratory"]),

  // Drives adaptiveCandidateLimit()/adaptiveRerankLimit().
  complexity: z.enum(["simple", "moderate", "complex"]),
});

export interface QueryPlan {
  originalQuery: string;
  rewrittenQueries: string[];
  isMultiHop: boolean;
  subQuestions: string[];
  queryType: QueryType;
  complexity: QueryComplexity;
  /** Deterministic reading of the question (intent, explicit dates/amounts, negations, ambiguity). */
  understanding?: QueryUnderstanding;
  /** "model" when the model's rewrite/classification was used, "fallback" when the local path was. */
  planSource?: "model" | "fallback";
  /** Observability only — never contains question text or figures. */
  planMeta?: { cacheHit: boolean; retries: number; rejectedPhrasings: number; latencyMs: number };
}

@Injectable()
export class QueryRewriteService {
  constructor(private gateway: AiGatewayService) {}

  async plan(userId: string, query: string): Promise<QueryPlan> {
    const startedAt = Date.now();
    const understanding = understandQuery(query);

    // Nothing to search for (e.g. "what about it?"): skip the model call entirely.
    if (understanding.needsClarification) {
      return {
        originalQuery: query,
        rewrittenQueries: [query],
        isMultiHop: false,
        subQuestions: [],
        queryType: "exploratory",
        complexity: "simple",
        understanding,
        planSource: "fallback",
        planMeta: { cacheHit: false, retries: 0, rejectedPhrasings: 0, latencyMs: 0 },
      };
    }

    try {
      const result = await withStageTimeout(
        (signal) =>
          this.gateway.extract(query, rewriteSchema, {
            feature: "rag.query_rewrite",
            promptName: "rag.query_rewrite",
            userId,
            cacheable: true,
            // The original query is always searched too, so a failed rewrite is not worth repeating.
            maxCorrectiveRetries: REWRITE_MAX_CORRECTIVE_RETRIES,
            // The stage budget cancels the call instead of leaving it running in the background.
            signal,
          }),
        RAG_STAGE_TIMEOUTS_MS.rewrite,
        "Query rewrite",
      );

      // A phrasing that drops an amount/date or flips a negation changes what the user asked.
      const safePhrasings = result.data.rewrittenQueries.filter((q) => rewritePreservesMeaning(query, q));
      const rejectedPhrasings = result.data.rewrittenQueries.length - safePhrasings.length;

      const safeSubQuestions = result.data.isMultiHop
        ? result.data.subQuestions.filter((q) => introducesNoNewFigures(query, q) && !hasNewNegation(query, q))
        : [];
      const isMultiHop = result.data.isMultiHop && safeSubQuestions.length > 0;

      return {
        originalQuery: query,
        rewrittenQueries: withDeterministicPhrasings(query, safePhrasings),
        isMultiHop,
        subQuestions: isMultiHop ? safeSubQuestions : [],
        queryType: result.data.queryType,
        complexity: result.data.complexity,
        understanding,
        planSource: "model",
        planMeta: {
          cacheHit: result.meta?.cacheHit ?? false,
          retries: result.meta?.retries ?? 0,
          rejectedPhrasings,
          latencyMs: Date.now() - startedAt,
        },
      };
    } catch (err) {
      // Query rewriting and classification are enhancements, not hard dependencies.
      // If the model call, validation or time budget fails, retrieve using the original
      // query instead of failing the entire search.
      if (err instanceof AiUnavailableException || err instanceof Error) {
        const local = heuristicPlanFields(query, understanding);
        return {
          originalQuery: query,
          rewrittenQueries: [query],
          isMultiHop: false,
          subQuestions: [],
          queryType: local.queryType,
          complexity: local.complexity,
          understanding,
          planSource: "fallback",
          planMeta: { cacheHit: false, retries: 0, rejectedPhrasings: 0, latencyMs: Date.now() - startedAt },
        };
      }

      throw err;
    }
  }
}

const NEGATION_TOKENS = /\b(not|no|never|without|excluding|exclude|except|besides|ignoring)\b/i;

/** A sub-question must not introduce a negation the user did not write. */
function hasNewNegation(original: string, derived: string): boolean {
  return NEGATION_TOKENS.test(derived) && !NEGATION_TOKENS.test(original);
}

/**
 * Adds deterministic phrasings to the model-generated queries:
 * 1. The original query is always first.
 * 2. Model-generated alternatives are added without duplicates.
 * 3. Content words and related finance terms improve retrieval recall.
 *
 * The resulting list is deduplicated and capped at four queries.
 */
export function withDeterministicPhrasings(
  query: string,
  modelPhrasings: string[],
): string[] {
  const out: string[] = [];

  const push = (q: string) => {
    const trimmed = q.trim();

    if (
      trimmed &&
      !out.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())
    ) {
      out.push(trimmed);
    }
  };

  push(query);

  for (const phrasing of modelPhrasings) {
    push(phrasing);
  }

  const core = contentTerms(query).join(" ");

  if (core) {
    push(core);
  }

  const extra = expansionTerms(query);

  if (core && extra.length > 0) {
    push(`${core} ${extra.join(" ")}`);
  }

  return out.slice(0, 4);
}
