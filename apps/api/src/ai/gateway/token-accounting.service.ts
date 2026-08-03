import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

export interface ModelPricing {
  /** USD per 1,000,000 prompt (input) tokens. */
  promptPer1M: number;
  /** USD per 1,000,000 completion (output) tokens. */
  completionPer1M: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

// Turns GroqClient's real, billed usage figures (GroqChatResult.promptTokens /
// completionTokens, read directly off Groq's response body's `usage` block — see
// groq.client.ts) into an actual dollar figure. This is the "exact token accounting"
// half of the AI Gateway: TokenBudgetService's ~4-chars-per-token estimate exists only
// to decide, BEFORE a call, whether to trim input to fit the context window, and is
// explicitly documented there as not being accurate enough for cost accounting. This
// class is the other half — AFTER a call, using the real numbers Groq itself reports —
// and is deliberately kept as a separate class rather than folded into
// TokenBudgetService so the "estimate for trimming" and "exact figure for billing"
// concerns can't accidentally get confused for one another at a call site.
@Injectable()
export class TokenAccountingService {
  constructor(private config: ConfigService) {}

  private pricingFor(model: string): ModelPricing | null {
    const table = this.config.get<Record<string, ModelPricing>>("ai.modelPricing") ?? {};
    return table[model] ?? null;
  }

  /** Returns null — never a silently-wrong number — when `model` isn't in the
   * configured pricing table, e.g. an operator overrode GROQ_LARGE_MODEL to a model
   * string nobody has priced yet in configuration.ts's ai.modelPricing. Callers and
   * AiLoggingService both treat null as "cost unknown", not "cost $0". */
  estimateCostUsd(model: string, usage: TokenUsage): number | null {
    const pricing = this.pricingFor(model);
    if (!pricing) return null;
    const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptPer1M;
    const completionCost = (usage.completionTokens / 1_000_000) * pricing.completionPer1M;
    return Number((promptCost + completionCost).toFixed(8));
  }
}
