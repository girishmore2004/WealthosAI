import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  AiComplexityHint,
  AiTaskType,
  RoutingReason,
} from "./ai-gateway.types";
import { ModelRoutingStatsService } from "./model-routing-stats.service";

export interface RoutingDecision {
  model: string;
  temperature: number;
  reason: RoutingReason;
  chain: string[];
}

const LARGE_MODEL_TASKS: ReadonlySet<AiTaskType> = new Set([
  "generation",
  "summarization",
]);

const TASK_TEMPERATURE: Record<AiTaskType, number> = {
  classification: 0,
  extraction: 0,
  ranking: 0,
  summarization: 0.3,
  generation: 0.4,
};

function inferComplexity(
  input: string,
): AiComplexityHint {
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

  resolveChain(
    taskType: AiTaskType,
    input: string,
    context: RoutingContext,
  ): RoutingDecision {
    const configuredProvider = (
      this.config.get<string>("ai.primaryProvider") ?? "groq"
    ).toLowerCase();

    const useOpenAi =
      configuredProvider === "openai" &&
      !!this.config.get<string>("ai.openAiApiKey");

    // Select provider-specific primary models.
    const small = useOpenAi
      ? `openai:${this.config.get<string>("ai.openAiSmallModel") ?? "gpt-4o-mini"}`
      : this.config.get<string>("ai.smallModel")!;

    const large = useOpenAi
      ? `openai:${this.config.get<string>("ai.openAiLargeModel") ?? "gpt-4o"}`
      : this.config.get<string>("ai.largeModel")!;

    const fallback =
      this.config.get<string>("ai.fallbackModel") || small;

    const complexity =
      context.complexityHint ?? inferComplexity(input);

    const taskDefaultsToLarge =
      LARGE_MODEL_TASKS.has(taskType);

    // STEP 1: Task complexity routing.

    let primary = taskDefaultsToLarge
      ? large
      : small;

    let reason: RoutingReason = "task_default";

    if (small !== large) {
      if (
        !taskDefaultsToLarge &&
        complexity === "high"
      ) {
        primary = large;
        reason = "complexity_upgrade";
      } else if (
        taskDefaultsToLarge &&
        context.complexityHint === "low"
      ) {
        primary = small;
        reason = "complexity_downgrade";
      }
    }

    // STEP 2: Historical accuracy routing.

    if (small !== large) {
      const altModel =
        primary === large ? small : large;

      const primaryStats =
        this.stats.getStats(primary, taskType);

      const altStats =
        this.stats.getStats(altModel, taskType);

      if (
        primaryStats &&
        altStats &&
        primaryStats.sampleSize >=
          ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        altStats.sampleSize >=
          ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        primaryStats.failureRate -
          altStats.failureRate >
          0.15
      ) {
        primary = altModel;
        reason = "accuracy_downgrade";
      }
    }

    // STEP 3: Latency-aware routing.

    if (
      context.maxLatencyMs &&
      primary === large
    ) {
      const largeStats =
        this.stats.getStats(large, taskType);

      const smallStats =
        this.stats.getStats(small, taskType);

      if (
        largeStats &&
        largeStats.sampleSize >=
          ModelRoutingStatsService.MIN_SAMPLE_SIZE &&
        largeStats.p95LatencyMs >
          context.maxLatencyMs &&
        (!smallStats ||
          smallStats.p95LatencyMs <=
            context.maxLatencyMs)
      ) {
        primary = small;
        reason = "latency_downgrade";
      }
    }

    // STEP 4: Cost-aware routing.

    if (
      context.maxCostUsd &&
      primary === large
    ) {
      const pricing =
        this.config.get<
          Record<
            string,
            {
              promptPer1M: number;
              completionPer1M: number;
            }
          >
        >("ai.modelPricing");

      const largePrice =
        pricing?.[large] ??
        pricing?.[
          large.replace(/^(openai|groq):/, "")
        ];

      if (largePrice) {
        const roughPromptTokens =
          input.length / 4;

        const roughCostUsd =
          (roughPromptTokens / 1_000_000) *
            largePrice.promptPer1M +
          (300 / 1_000_000) *
            largePrice.completionPer1M;

        if (
          roughCostUsd > context.maxCostUsd
        ) {
          primary = small;
          reason = "budget_downgrade";
        }
      }
    }

    // STEP 5: Build provider fallback chain.

    const secondary =
      primary === large ? small : large;

    let chain: string[];

    if (useOpenAi) {
      const groqKeyConfigured =
        !!this.config.get<string>("ai.groqApiKey");

      if (groqKeyConfigured) {
        const groqSmall =
          `groq:${this.config.get<string>("ai.smallModel") ?? "openai/gpt-oss-20b"}`;

        const groqLarge =
          `groq:${this.config.get<string>("ai.largeModel") ?? "openai/gpt-oss-120b"}`;

        const matchingGroq =
          primary === large
            ? groqLarge
            : groqSmall;

        const alternateGroq =
          primary === large
            ? groqSmall
            : groqLarge;

        // OpenAI first, then matching Groq model,
        // then the alternate OpenAI and Groq models.

        chain = Array.from(
          new Set([
            primary,
            matchingGroq,
            secondary,
            alternateGroq,
          ]),
        );
      } else {
        // OpenAI-only mode.

        chain = Array.from(
          new Set([
            primary,
            secondary,
          ]),
        );
      }
    } else {
      // Legacy Groq-only mode.

      chain = Array.from(
        new Set([
          primary,
          secondary,
          fallback,
        ]),
      );
    }

    return {
      model: primary,
      temperature: this.temperatureFor(taskType),
      reason,
      chain,
    };
  }
}
