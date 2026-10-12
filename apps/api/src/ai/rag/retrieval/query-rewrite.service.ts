import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { QueryComplexity, QueryType } from "../rag.constants";
import { contentTerms, expansionTerms } from "./keyword-scorer.service";

const rewriteSchema = z.object({
  // Alternate phrasings of the same question — improves recall against chunk text
  // that doesn't share the user's exact wording (e.g. "how's my debt" vs. "what do I
  // owe" vs. "loan balance").
  rewrittenQueries: z.array(z.string()).min(1).max(3),

  // True when the question genuinely bundles more than one thing that would each need
  // their own retrieval pass to answer well.
  isMultiHop: z.boolean(),

  subQuestions: z.array(z.string()).max(4),

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
}

@Injectable()
export class QueryRewriteService {
  constructor(private gateway: AiGatewayService) {}

  async plan(userId: string, query: string): Promise<QueryPlan> {
    try {
      const result = await this.gateway.extract(query, rewriteSchema, {
        feature: "rag.query_rewrite",
        promptName: "rag.query_rewrite",
        userId,
        cacheable: true,
      });

      return {
        originalQuery: query,
        rewrittenQueries: withDeterministicPhrasings(
          query,
          result.data.rewrittenQueries,
        ),
        isMultiHop: result.data.isMultiHop,
        subQuestions: result.data.isMultiHop
          ? result.data.subQuestions
          : [],
        queryType: result.data.queryType,
        complexity: result.data.complexity,
      };
    } catch (err) {
      // Query rewriting and classification are enhancements, not hard dependencies.
      // If the model call or validation fails, retrieve using the original query
      // instead of failing the entire search.
      if (err instanceof AiUnavailableException || err instanceof Error) {
        return {
          originalQuery: query,
          rewrittenQueries: [query],
          isMultiHop: false,
          subQuestions: [],
          queryType: "exploratory",
          complexity: heuristicComplexity(query),
        };
      }

      throw err;
    }
  }
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

/**
 * Local fallback for complexity classification when the AI gateway is unavailable.
 *
 * This intentionally uses simple heuristics because it only runs as a fallback.
 * The default query type remains "exploratory", which uses the default retrieval
 * weight profile when the model cannot classify the query.
 */
function heuristicComplexity(query: string): QueryComplexity {
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;

  const hasCompoundSignal =
    /\band\b|\bcompare\b|\bversus\b|\bvs\.?\b/i.test(query) ||
    (query.match(/\?/g)?.length ?? 0) > 1;

  if (hasCompoundSignal) {
    return "complex";
  }

  if (wordCount <= 6) {
    return "simple";
  }

  return "moderate";
}
