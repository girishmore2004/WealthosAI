import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";

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
});

export interface QueryPlan {
  originalQuery: string;
  rewrittenQueries: string[];
  isMultiHop: boolean;
  subQuestions: string[];
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
      };
    } catch (err) {
      // Query rewriting is an enhancement, not a hard dependency — if the model call
      // itself fails (AiUnavailableException), fall back to running retrieval against
      // the original query verbatim rather than failing the whole search. A
      // validation failure (AiValidationException) is treated the same way here for
      // the same reason: better to search once with what the user typed than not
      // search at all.
      if (err instanceof AiUnavailableException || err instanceof Error) {
        return { originalQuery: query, rewrittenQueries: [query], isMultiHop: false, subQuestions: [] };
      }
      throw err;
    }
  }
}
