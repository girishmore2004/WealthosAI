import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AiComplexityHint, AiTaskType, RoutingReason } from "./ai-gateway.types";
import { ModelRoutingStatsService } from "./model-routing-stats.service";

export interface RoutingDecision {
  /** The model AiGatewayService should try first. */
  model: string;
  temperature: number;
  /** Why `model` was picked over the task type's plain default — purely for
   * logging/AiInteractionLog.routingReason, never branched on by callers. */
  reason: RoutingReason;
  /** Ordered candidate list, `model` first, that AiGatewayService walks through on a
   * transport failure (AiUnavailableException) — see its runStructured() fallback
   * loop. This is "dynamic model routing" and "automatic fallback chain" sharing one
   * mechanism: routing decides the order once per call, the gateway walks it if
   * needed. */
  chain: string[];
}

// Classification/extraction/ranking are "read the input, pick/pull/order something" —
// cheap, low-reasoning tasks well suited to a small fast model. Generation and
// summarization are asked to actually compose prose, which benefits more from a
// larger model's reasoning. This remains the routing *default*; everything else in
// this class is a bounded nudge off that default based on real signals (complexity,
// recent accuracy, recent latency, a per-call budget), never a coin flip and never a
// change so large the caller's declared task type stops mattering.
const LARGE_MODEL_TASKS: ReadonlySet<AiTaskType> = new Set(["generation", "summarization"]);

// Deterministic-leaning tasks default to temperature 0 (same input should tend to give
// the same output — this also makes AiCacheService's cache meaningfully useful for
// them). Generation/summarization get a little room to vary since forcing temperature
// 0 on prose composition tends to produce noticeably flatter, more repetitive output.
const TASK_TEMPERATURE: Record<AiTaskType, number> = {
  classification: 0,
  extraction: 0,
  ranking: 0,
  summarization: 0.3,
  generation: 0.4,
};

// A rough complexity heuristic off input shape alone, used only when the caller didn't
// pass an explicit complexityHint via AiCallOptions.complexityHint. Deliberately crude
// (char count only) for the same reason TokenBudgetService's token estimate is crude:
// a real complexity classifier would itself be another model call, defeating the point
// of a routing decision that has to be cheap enough to make before the real call.
// Callers that know better (e.g. RAG's query rewrite is always cheap regardless of
// question length; Scenario Studio's explanation step is always reasoning-heavy even
// over a short facts block) should pass complexityHint explicitly rather than rely on
// this inference.
function inferComplexity(input: string): AiComplexityHint {
  if (input.length > 3000) return "high";
  if (input.length > 800) return "medium";
  return "low";
}

export interface RoutingContext {
  complexityHint?: AiComplexityHint;
  maxLatencyMs?: number;
  maxCostUsd?: number;
}

@Injectable()
export class ModelRouterService {
  constructor(
    private config: ConfigService,
    private stats: ModelRoutingStatsService,
  ) {}

  temperatureFor(taskType: AiTaskType): number {
    return TASK_TEMPERATURE[taskType];
  }

  /** Resolves both the model to try first AND the full fallback chain for one call.
   * Every signal below is a bounded, explainable nudge (see RoutingReason) — this is
   * intentionally NOT a black-box scoring function; a human reading
   * AiInteractionLog.routingReason should always be able to tell exactly which rule
   * fired, matching this codebase's existing "explainable over clever" convention
   * (see e.g. the Dashboard health score's own design notes). */
  resolveChain(taskType: AiTaskType, input: string, context: RoutingContext): RoutingDecision {
    const small = this.config.get<string>("ai.smallModel")!;
    const large = this.config.get<string>("ai.largeModel")!;
    const fallback = this.config.get<string>("ai.fallbackModel") || small;

    const complexity = context.complexityHint ?? inferComplexity(input);
    const taskDefaultsToLarge = LARGE_MODEL_TASKS.has(taskType);

    // Step 1 — task-type default, nudged by complexity in either direction.
    let primary = taskDefaultsToLarge ? large : small;
    let reason: RoutingReason = "task_default";

    if (small !== large) {
      if (!taskDefaultsToLarge && complexity === "high") {
        primary = large;
        reason = "complexity_upgrade";
      } else if (taskDefaultsToLarge && context.complexityHint === "low") {
        // Downgrading a large-default task requires an EXPLICIT complexityHint of
        // "low" from a caller who actually knows the input is simple — unlike the
        // upgrade branch above, this never fires off the crude inferred heuristic.
        // inferComplexity() is length-based only, and most generation/summarization
        // inputs are short by nature (a prompt, not the document being summarized),
        // so inferring "low" from length alone would downgrade the large-default task
        // type back to small for the common case, defeating the point of the default.
        primary = small;
        reason = "complexity_downgrade";
      }
    }

    // Step 2 — accuracy signal: prefer whichever of {small, large} has a materially
    // lower recent validation-failure rate for this exact task type, but only once
    // both have enough samples to trust the comparison (see
    // ModelRoutingStatsService.MIN_SAMPLE_SIZE) — a cold-start process with no history
    // yet must fall through to the task-type default, never guess off 1-2 samples.
    if (small !== large) {
      const altModel = primary === large ? small : large;
      const primaryStats = this.stats.getStats(primary, taskType);
      const altStats = this.stats.getStats(altModel, taskType);
      if (
        primaryStats &&
        altStats &&
        primaryStats.sampleSize >= ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        altStats.sampleSize >= ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        primaryStats.failureRate - altStats.failureRate > 0.15
      ) {
        primary = altModel;
        reason = "accuracy_downgrade";
      }
    }

    // Step 3 — latency signal: only ever downgrades large -> small (never the reverse
    // — a caller asking for a latency ceiling never gets bumped to a *slower* model
    // just because it happens to validate more reliably; steps 2 and 3 are kept from
    // fighting each other by only letting latency override in this one direction).
    if (context.maxLatencyMs && primary === large) {
      const largeStats = this.stats.getStats(large, taskType);
      const smallStats = this.stats.getStats(small, taskType);
      if (
        largeStats &&
        largeStats.sampleSize >= ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        largeStats.p95LatencyMs > context.maxLatencyMs &&
        (!smallStats || smallStats.p95LatencyMs <= context.maxLatencyMs)
      ) {
        primary = small;
        reason = "latency_downgrade";
      }
    }

    // Step 4 — budget signal: a rough $/call estimate (input size at the same
    // ~4-chars-per-token heuristic TokenBudgetService uses, plus a fixed 300-token
    // completion assumption) compared against the caller's declared ceiling. This is
    // intentionally rough — TokenAccountingService owns the real, post-call, exact
    // cost math once real usage is known; this only needs to answer "would the pricier
    // candidate plausibly blow the ceiling" before a call is made at all.
    if (context.maxCostUsd && primary === large) {
      const pricing = this.config.get<Record<string, { promptPer1M: number; completionPer1M: number }>>(
        "ai.modelPricing",
      );
      const largePrice = pricing?.[large];
      if (largePrice) {
        const roughPromptTokens = input.length / 4;
        const roughCostUsd =
          (roughPromptTokens / 1_000_000) * largePrice.promptPer1M + (300 / 1_000_000) * largePrice.completionPer1M;
        if (roughCostUsd > context.maxCostUsd) {
          primary = small;
          reason = "budget_downgrade";
        }
      }
    }

    // The fallback chain AiGatewayService walks on transport failure: primary first,
    // then whichever of {large, small} wasn't picked, then a dedicated third
    // `ai.fallbackModel` (falls back to the small model if that's unset, so this is
    // never empty). De-duplicated in order so a misconfiguration that points
    // fallbackModel at the same string as small/large doesn't produce a chain that
    // retries the same failing model twice.
    const secondary = primary === large ? small : large;
    const chain = Array.from(new Set([primary, secondary, fallback]));

    return { model: primary, temperature: this.temperatureFor(taskType), reason, chain };
  }
}
