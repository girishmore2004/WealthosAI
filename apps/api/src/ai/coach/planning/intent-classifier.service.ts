import { Injectable } from "@nestjs/common";
import { matchIntent, CoachIntent } from "../../../coach/coach.intents";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ADVANCED_INTENT_DESCRIPTIONS, ADVANCED_INTENT_LABELS, AdvancedCoachIntent } from "../coach2.constants";

export type ClassificationResult =
  | { path: "deterministic"; intent: CoachIntent }
  | { path: "advanced"; intent: AdvancedCoachIntent; confidence: number }
  | { path: "advanced"; intent: "general_search"; confidence: number }; // fallback when classification itself is unavailable

// This is the "explanation layer over the existing deterministic router, not a
// replacement" the roadmap called for, made concrete: matchIntent() (the original
// Phase 5 keyword router) is tried FIRST and wins if it matches anything — the model
// is only ever consulted for questions the deterministic router doesn't recognize at
// all. A known question about net worth, goals, tax, etc. always takes the
// deterministic path, unchanged from before this phase existed.
@Injectable()
export class IntentClassifierService {
  constructor(private gateway: AiGatewayService) {}

  async classify(userId: string, question: string): Promise<ClassificationResult> {
    const deterministic = matchIntent(question);
    if (deterministic) {
      return { path: "deterministic", intent: deterministic };
    }

    try {
      const descriptions = ADVANCED_INTENT_LABELS.map((label) => `- ${label}: ${ADVANCED_INTENT_DESCRIPTIONS[label]}`).join("\n");
      const result = await this.gateway.classify(`${question}\n\nCategories:\n${descriptions}`, ADVANCED_INTENT_LABELS, {
        feature: "coach2.classify_advanced",
        promptName: "coach2.classify_advanced",
        userId,
        cacheable: false, // same question phrasing could plausibly need re-evaluation as the user's own data changes; not worth the staleness risk to cache
      });
      return { path: "advanced", intent: result.data.label, confidence: result.confidence };
    } catch (err) {
      // Classification is a real dependency for the advanced path (unlike query
      // rewriting/reranking in RAG, there's no cheap deterministic substitute for
      // "which of five categories is this") — but rather than fail the whole request,
      // fall back to treating it as a general search, which itself degrades
      // gracefully (RagService returns a clear "no evidence" answer if it can't find
      // anything either).
      if (err instanceof AiUnavailableException || err instanceof Error) {
        return { path: "advanced", intent: "general_search", confidence: 0 };
      }
      throw err;
    }
  }
}
