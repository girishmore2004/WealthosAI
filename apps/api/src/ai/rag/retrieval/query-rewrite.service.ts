```typescript
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
      // Query rewriting is an enhancement, not a hard dependency.
      // If the gateway is unavailable or the response is invalid, search using
      // the original user query rather than failing the entire retrieval flow.
      //
      // Do not expand the fallback query here: simple fallback classifications
      // must preserve the original wording for predictable retrieval behavior.
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
 * Adds model-free phrasings to the original query and model-generated
 * alternatives to improve retrieval recall.
 *
 * Includes:
 * 1. The original user query.
 * 2. Model-generated alternate phrasings.
 * 3. A version containing the user's content words.
 * 4. A version expanded with related finance terminology.
 *
 * Queries are de-duplicated case-insensitively and capped at four.
 */
export function withDeterministicPhrasings(
  query: string,
  modelPhrasings: string[],
): string[] {
  const out: string[] = [];

  const push = (q: string) => {
    const t = q.trim();

    if (t && !out.some((existing) => existing.toLowerCase() === t.toLowerCase())) {
      out.push(t);
    }
  };

  push(query);

  for (const q of modelPhrasings) {
    push(q);
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
 * Model-free fallback for query complexity when the AI gateway is unavailable.
 *
 * This heuristic is deliberately simple because it is only used as a fallback,
 * not as the primary classifier.
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
```
