import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { MerchantMemoryService } from "./merchant-memory.service";
import { CategoryRankingModel, RankingCandidate, SuggestionSource } from "../scoring/category-ranking.model";
import { ruleBasedCategorySuggestion } from "./rule-based-category-fallback";
import { MIN_CONFIDENCE_FOR_MEMORY_AUTO_SUGGEST } from "../copilot-ingestion.constants";

export interface CategorySuggestion {
  categoryId: string | null;
  categoryName: string | null;
  confidence: number;
  /** Which signal ultimately produced this suggestion — persisted on the review item
   * (IngestionReviewItem.suggestionSource) so IngestionReviewService can attribute a
   * later human approval/override back to the right source for
   * CategoryRankingModel#learnFromCorrection and MerchantMemoryService#recordFeedback. */
  source: SuggestionSource;
  /** How many prior observations personal memory has for this merchant (0 if none) —
   * surfaced so SuggestionScoringService can flag low-sample-size suggestions for
   * active learning even when the blended confidence number looks acceptable. */
  memorySampleSize: number;
}

@Injectable()
export class CategorySuggestionService {
  private readonly logger = new Logger(CategorySuggestionService.name);

  constructor(
    private gateway: AiGatewayService,
    private memory: MerchantMemoryService,
    private ranking: CategoryRankingModel,
  ) {}

  /** Classifies against the exact list of the user's own existing categories. Every
   * candidate this method can return — from personal memory, the cross-user global
   * stat, or the AI Gateway's classify() — is validated against `categories` before
   * it can win, so it remains structurally impossible to suggest a category that
   * doesn't already exist in the user's account, exactly as before this feature's
   * changes.
   *
   * Pipeline, in order (each step only runs if the previous one didn't already return
   * a confident answer):
   *   1. Personal merchant memory, exact normalized-merchant key — cheapest, most
   *      personalized, no AI call at all once a merchant is well-established.
   *   2. Personal merchant memory, embedding-similarity fuzzy match — only attempted
   *      when there's no exact-key row, catches near-duplicate merchant strings.
   *   3. AI Gateway classify() + the cross-user global stat prior, blended by
   *      CategoryRankingModel (this also covers the case where memory found something
   *      but below the auto-suggest confidence bar — it becomes one more candidate fed
   *      into the same ranking blend rather than being thrown away).
   *   4. Deterministic rule-based keyword fallback — only reached when the AI Gateway
   *      itself is unavailable and nothing else produced a candidate; guarantees "no
   *      hallucinated fields" even during a Groq outage. */
  async suggest(userId: string, merchantNormalized: string, categories: { id: string; name: string }[]): Promise<CategorySuggestion> {
    if (categories.length === 0) {
      return { categoryId: null, categoryName: null, confidence: 0, source: "none", memorySampleSize: 0 };
    }

    const exactMemory = await this.memory.lookup(userId, merchantNormalized);
    if (exactMemory && exactMemory.confidence >= MIN_CONFIDENCE_FOR_MEMORY_AUTO_SUGGEST && categories.some((c) => c.id === exactMemory.categoryId)) {
      return {
        categoryId: exactMemory.categoryId,
        categoryName: exactMemory.categoryName,
        confidence: exactMemory.confidence,
        source: "memory",
        memorySampleSize: exactMemory.sampleSize,
      };
    }

    const fuzzyMemory = exactMemory ? null : await this.memory.lookupFuzzy(userId, merchantNormalized);
    if (fuzzyMemory && fuzzyMemory.confidence >= MIN_CONFIDENCE_FOR_MEMORY_AUTO_SUGGEST && categories.some((c) => c.id === fuzzyMemory.categoryId)) {
      return {
        categoryId: fuzzyMemory.categoryId,
        categoryName: fuzzyMemory.categoryName,
        confidence: fuzzyMemory.confidence,
        source: "memory",
        memorySampleSize: fuzzyMemory.sampleSize,
      };
    }

    const memoryForRanking = exactMemory ?? fuzzyMemory;
    const memoryCandidate: RankingCandidate | null = memoryForRanking
      ? { categoryId: memoryForRanking.categoryId, categoryName: memoryForRanking.categoryName, confidence: memoryForRanking.confidence }
      : null;

    const globalStat = await this.memory.globalLookup(merchantNormalized, categories);
    const globalMatch = globalStat ? categories.find((c) => c.name.toLowerCase() === globalStat.categoryName.toLowerCase()) : undefined;
    const globalCandidate: RankingCandidate | null =
      globalStat && globalMatch ? { categoryId: globalMatch.id, categoryName: globalMatch.name, confidence: globalStat.confidence } : null;

    let aiCandidate: RankingCandidate | null = null;
    let aiUnavailable = false;
    try {
      const names = categories.map((c) => c.name) as [string, ...string[]];
      const result = await this.gateway.classify(`Merchant: ${merchantNormalized}`, names, {
        feature: "copilot_ingestion.suggest_category",
        promptName: "copilot_ingestion.suggest_category",
        userId,
        cacheable: true, // same merchant string will very often recur across a statement and across imports
      });
      const match = categories.find((c) => c.name === result.data.label);
      if (match) aiCandidate = { categoryId: match.id, categoryName: match.name, confidence: result.confidence };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Category suggestion unavailable for "${merchantNormalized}": ${err.message}`);
        aiUnavailable = true;
      } else {
        throw err;
      }
    }

    const ranked = await this.ranking.rank(userId, { memory: memoryCandidate, ai: aiCandidate, global: globalCandidate });
    if (ranked) {
      return { ...ranked, memorySampleSize: memoryForRanking?.sampleSize ?? 0 };
    }

    if (aiUnavailable) {
      const fallback = ruleBasedCategorySuggestion(merchantNormalized, categories);
      if (fallback) {
        return { ...fallback, source: "rule_based_fallback", memorySampleSize: 0 };
      }
    }

    return { categoryId: null, categoryName: null, confidence: 0, source: "none", memorySampleSize: 0 };
  }
}
