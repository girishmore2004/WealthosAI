import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";

export interface CategorySuggestion {
  categoryId: string | null;
  categoryName: string | null;
  confidence: number;
}

@Injectable()
export class CategorySuggestionService {
  private readonly logger = new Logger(CategorySuggestionService.name);

  constructor(private gateway: AiGatewayService) {}

  /** Classifies against the exact list of the user's own existing categories — the
   * model picks from a closed set (`AiGatewayService.classify()`'s label list), so it
   * is structurally impossible for this to suggest a category that doesn't already
   * exist in the user's account. */
  async suggest(userId: string, merchantNormalized: string, categories: { id: string; name: string }[]): Promise<CategorySuggestion> {
    if (categories.length === 0) {
      return { categoryId: null, categoryName: null, confidence: 0 };
    }

    const names = categories.map((c) => c.name) as [string, ...string[]];

    try {
      const result = await this.gateway.classify(`Merchant: ${merchantNormalized}`, names, {
        feature: "copilot_ingestion.suggest_category",
        promptName: "copilot_ingestion.suggest_category",
        userId,
        cacheable: true, // same merchant string will very often recur across a statement and across imports
      });

      const match = categories.find((c) => c.name === result.data.label);
      return { categoryId: match?.id ?? null, categoryName: match?.name ?? null, confidence: result.confidence };
    } catch (err) {
      if (err instanceof AiUnavailableException) {
        this.logger.warn(`Category suggestion unavailable for "${merchantNormalized}": ${err.message}`);
        return { categoryId: null, categoryName: null, confidence: 0 };
      }
      throw err;
    }
  }
}
