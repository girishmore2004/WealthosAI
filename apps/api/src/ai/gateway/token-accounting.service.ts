import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

@Injectable()
export class TokenAccountingService {
  constructor(private config: ConfigService) {}

  private pricingFor(
    model: string,
  ): ModelPricing | null {
    const table =
      this.config.get<
        Record<string, ModelPricing>
      >("ai.modelPricing") ?? {};

    // Remove provider prefix:
    // openai:gpt-4o-mini -> gpt-4o-mini
    // groq:openai/gpt-oss-20b -> openai/gpt-oss-20b

    const unqualifiedModel =
      model.replace(/^(openai|groq):/, "");

    return (
      table[model] ??
      table[unqualifiedModel] ??
      null
    );
  }

  estimateCostUsd(
    model: string,
    usage: TokenUsage,
  ): number | null {
    const pricing = this.pricingFor(model);

    if (!pricing) {
      return null;
    }

    const promptCost =
      (usage.promptTokens / 1_000_000) *
      pricing.promptPer1M;

    const completionCost =
      (usage.completionTokens / 1_000_000) *
      pricing.completionPer1M;

    return Number(
      (promptCost + completionCost).toFixed(8),
    );
  }
}
