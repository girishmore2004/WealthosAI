import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { QueryComplexity, QueryType } from "../rag.constants";

const rewriteSchema = z.object({
  // Alternate phrasings of the same question — improves recall against chunk text
  // that doesn't share the user's exact wording (e.g. "how's my debt" vs. "what do I
  // owe" vs. "loan balance").
  rewrittenQueries: z.array(z.string()).min(1).max(3),
  // True when the question genuinely bundles more than one thing that would each need
  // their own retrieval pass to answer well (e.g. "compare my spending this month to
  // last month and tell me if I'm on track for my goals" — three sub-questions).
  isMultiHop: z.boolean(),
  subQuestions: z.array(z.string()).max(4),
  // Drives HybridRetrievalService's per-query-type weight profile (see
  // RETRIEVAL_WEIGHT_PROFILES) — "hybrid weight optimization per query type".
  // factual = a specific lookup ("what's my EMI"); comparative = across two periods/
  // entities ("this month vs last"); analytical = judgment over scattered evidence
  // ("am I on track for retirement"); exploratory = open-ended/general.
  queryType: z.enum(["factual", "comparative", "analytical", "exploratory"]),
  // Drives adaptiveCandidateLimit()/adaptiveRerankLimit() — "adaptive top-k based on
  // query complexity". simple = one clear fact; moderate = a normal single-topic
  // question; complex = compound/multi-hop or requires synthesizing many sources.
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
        rewrittenQueries: result.data.rewrittenQueries,
        isMultiHop: result.data.isMultiHop,
        subQuestions: result.data.isMultiHop ? result.data.subQuestions : [],
        queryType: result.data.queryType,
        complexity: result.data.complexity,
      };
    } catch (err) {
      // Query rewriting (and its query-type/complexity classification) is an
      // enhancement, not a hard dependency — if the model call itself fails
      // (AiUnavailableException), fall back to running retrieval against the
      // original query verbatim, with a cheap local heuristic standing in for the
      // classification that would otherwise have come from the model, rather than
      // failing the whole search. A validation failure (AiValidationException) is
      // treated the same way here for the same reason: better to search once with
      // what the user typed than not search at all.
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

/** Local, model-free fallback for `complexity` when the gateway call itself is
 * unavailable — deliberately crude (word count + a couple of compound-question
 * signals) since it only ever runs as a degrade path, not the primary classifier.
 * "exploratory" is always used as the fallback queryType (see catch block above)
 * because RETRIEVAL_WEIGHT_PROFILES.exploratory is literally RETRIEVAL_WEIGHTS, the
 * same default this app always used before per-type profiles existed — the safest
 * choice when there's no real classification to go on. */
function heuristicComplexity(query: string): QueryComplexity {
  const wordCount = query.trim().split(/\s+/).filter(Boolean).length;
  const hasCompoundSignal = /\band\b|\bcompare\b|\bversus\b|\bvs\.?\b/i.test(query) || (query.match(/\?/g)?.length ?? 0) > 1;
  if (hasCompoundSignal) return "complex";
  if (wordCount <= 6) return "simple";
  return "moderate";
}
