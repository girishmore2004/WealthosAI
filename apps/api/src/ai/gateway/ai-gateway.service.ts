import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { z } from "zod";
import { GroqClient } from "../groq/groq.client";
import { ModelRouterService } from "./model-router.service";
import { ModelRoutingStatsService } from "./model-routing-stats.service";
import { TokenAccountingService } from "./token-accounting.service";
import { GroundingService } from "./grounding.service";
import { SchemaValidatorService } from "./schema-validator.service";
import { TokenBudgetService } from "./token-budget.service";
import { RedactionService } from "./redaction.service";
import { PromptRegistryService } from "../ops/prompt-registry.service";
import { AiLoggingService } from "../ops/ai-logging.service";
import { AiCacheService } from "../ops/ai-cache.service";
import { AiGroundingException, AiValidationException } from "../exceptions/ai.exceptions";
import {
  AiCallOptions,
  AiResult,
  AiTaskType,
  classificationEnvelope,
  generationEnvelope,
  rankingEnvelope,
  summaryEnvelope,
  withConfidence,
} from "./ai-gateway.types";

const MAX_CONTEXT_TOKENS = 6000;
const MAX_OUTPUT_TOKENS = 1024;

// The AI Gateway. This is the ONE place in the codebase that talks to a model —
// every other AI feature (Coach, RAG, Scenario Studio, Copilot Ingestion, etc.) calls
// through here rather than hitting GroqClient directly, so redaction/budgeting/
// caching/logging/validation/routing/grounding is applied uniformly regardless of
// which feature is asking.
//
// Pipeline for every call: redact free text -> trim to token budget -> check exact-
// match cache, then similarity-based semantic cache, if cacheable -> resolve active
// prompt + resolve a dynamic model + fallback chain via ModelRouterService (complexity/
// accuracy/latency/budget-aware, see that class) -> call Groq, walking the fallback
// chain on transport failure -> validate with SchemaValidatorService, retrying with
// the validation issues fed back to the model on failure -> optionally score
// groundedness against caller-supplied context and retry once more if rejected -> log
// the interaction (status, exact token usage, cost, routing reason, grounding) ->
// write both caches on success -> return.
//
// Resilience properties this pipeline guarantees, all load-bearing for callers'
// documented `catch (e) { if (e instanceof AiUnavailableException) ...fallback... }`
// pattern (see ai.exceptions.ts and every feature under ai/*):
//   1. A transport-level failure only becomes a thrown AiUnavailableException after
//      EVERY candidate model in the router's fallback chain has been tried (see
//      model-router.service.ts's RoutingDecision.chain) — not just the first one.
//      Each candidate's own GroqClient.chat call has already exhausted its own
//      transport-level retry budget before moving to the next candidate; the model-
//      fallback loop here is reserved for "this whole model is unavailable", not
//      transient blips GroqClient already smooths over.
//   2. The final transport failure (after the chain is exhausted) is always logged
//      with status "ERROR" before it is rethrown — AiInteractionLog/recentStats() must
//      never under-report failures just because the model never actually answered.
//   3. AiCacheService being unavailable (e.g. a Redis blip), on either the exact-match
//      or semantic path, must never fail an AI call outright — same fail-open
//      philosophy AiLoggingService already documents for logging. A cache read/write
//      error is treated as a cache miss and the call proceeds to Groq.
//
// A note on `confidence` vs `groundingScore`: confidence is the model's own self-
// report (see ai-gateway.types.ts#withConfidence) — not a calibrated probability.
// groundingScore, when a caller supplies `groundingContext`, is computed independently
// by GroundingService by comparing the response against that context — it is a real,
// deterministic measurement, not another thing the model is asked to self-assess. The
// two are deliberately kept separate in AiResult rather than blended into one number.
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(
    private groq: GroqClient,
    private router: ModelRouterService,
    private routingStats: ModelRoutingStatsService,
    private tokenAccounting: TokenAccountingService,
    private grounding: GroundingService,
    private validator: SchemaValidatorService,
    private tokenBudget: TokenBudgetService,
    private redaction: RedactionService,
    private prompts: PromptRegistryService,
    private logging: AiLoggingService,
    private cache: AiCacheService,
    private config: ConfigService,
  ) {}

  async classify<T extends [string, ...string[]]>(
    input: string,
    labels: T,
    options: AiCallOptions,
  ): Promise<AiResult<{ label: T[number] }>> {
    const result = await this.runStructured("classification", classificationEnvelope(labels), input, options);
    // The envelope's generic inference through withConfidence() doesn't narrow cleanly
    // back to `{ label: T[number] }` for TypeScript — zod's ZodEnum<Writeable<T>>
    // output type and the caller-facing T[number] are structurally identical at
    // runtime but not provably so to the type-checker. Safe to assert here since
    // classificationEnvelope(labels) is the only schema this call path can produce.
    return result as unknown as AiResult<{ label: T[number] }>;
  }

  async extract<T extends z.ZodTypeAny>(
    input: string,
    schema: T,
    options: AiCallOptions,
  ): Promise<AiResult<z.infer<T>>> {
    return this.runStructured("extraction", withConfidence(schema), input, options);
  }

  async generate(input: string, options: AiCallOptions): Promise<AiResult<{ text: string }>> {
    return this.runStructured("generation", generationEnvelope, input, options);
  }

  async summarize(input: string, options: AiCallOptions): Promise<AiResult<{ summary: string }>> {
    return this.runStructured("summarization", summaryEnvelope, input, options);
  }

  async rank(
    items: string[],
    criterion: string,
    options: AiCallOptions,
  ): Promise<AiResult<{ orderedIndices: number[]; rationale: string }>> {
    const input = `Criterion: ${criterion}\n\nItems (rank by index, best first):\n${items
      .map((item, i) => `[${i}] ${item}`)
      .join("\n")}`;
    return this.runStructured("ranking", rankingEnvelope, input, options);
  }

  private defaultCacheable(taskType: AiTaskType): boolean {
    return taskType === "classification" || taskType === "extraction" || taskType === "ranking";
  }

  /** Semantic caching defaults on for the same task types the exact-match cache
   * defaults on for (deterministic-ish "pick/pull/order something" tasks), and
   * defaults OFF for generation/summarization even when a caller forces
   * `cacheable: true` on those — prose composition is exactly the case where two
   * *similar but not identical* prompts often should NOT collapse to the same cached
   * text (see AiCallOptions.semanticCache's doc comment). */
  private defaultSemanticCacheable(taskType: AiTaskType, cacheable: boolean): boolean {
    return cacheable && this.defaultCacheable(taskType);
  }

  private async runStructured<TSchema extends z.ZodTypeAny>(
    taskType: AiTaskType,
    envelope: TSchema,
    rawInput: string,
    options: AiCallOptions,
  ): Promise<AiResult<z.infer<TSchema>["result"]>> {
    const startedAt = Date.now();
    const cacheable = options.cacheable ?? this.defaultCacheable(taskType);
    const semanticCacheEnabled = options.semanticCache ?? this.defaultSemanticCacheable(taskType, cacheable);
    const semanticThreshold = options.semanticCacheThreshold ?? this.config.get<number>("ai.semanticCacheThreshold")!;
    // Grounding's low/medium/high risk buckets are owned entirely by
    // GroundingService.score() (0.85/0.6 cutoffs) rather than a second configurable
    // threshold here — one source of truth for "what counts as ungrounded" that both
    // AiResult.hallucinationRisk and the reject-and-retry check below agree on.

    const { text: redactedInput, redactedTypes } = this.redaction.redact(rawInput);
    const { text: budgetedInput, wasTrimmed } = this.tokenBudget.trimToBudget(redactedInput, MAX_CONTEXT_TOKENS);

    if (redactedTypes.length > 0) {
      this.logger.debug(
        `Redacted PII types [${redactedTypes.join(", ")}] from input for feature "${options.feature}" (prompt "${options.promptName}")`,
      );
    }
    if (wasTrimmed) {
      this.logger.warn(
        `Input for feature "${options.feature}" (prompt "${options.promptName}") exceeded the ${MAX_CONTEXT_TOKENS}-token budget and was trimmed — this may reduce answer quality/grounding.`,
      );
    }

    const prompt = await this.prompts.getActive(options.promptName);

    // --- Cache lookup: exact match first, then similarity-based, both fail-open ----
    if (cacheable) {
      let cached: z.infer<TSchema> | null = null;
      try {
        cached = await this.cache.get<z.infer<TSchema>>(options.feature, prompt.name, prompt.version, budgetedInput);
      } catch (err) {
        this.logger.warn(
          `AiCacheService.get failed for "${prompt.name}" (feature "${options.feature}") — proceeding without cache: ${(err as Error).message}`,
        );
      }
      let cacheType: "exact" | "semantic" | null = cached ? "exact" : null;

      if (!cached && semanticCacheEnabled) {
        try {
          const semanticHit = await this.cache.getSemantic<z.infer<TSchema>>(
            options.feature,
            prompt.name,
            prompt.version,
            budgetedInput,
            semanticThreshold,
          );
          if (semanticHit) {
            cached = semanticHit.value;
            cacheType = "semantic";
          }
        } catch (err) {
          this.logger.warn(
            `AiCacheService.getSemantic failed for "${prompt.name}" (feature "${options.feature}") — proceeding without semantic cache: ${(err as Error).message}`,
          );
        }
      }

      if (cached) {
        // Grounding is scored against THIS call's context even on a cache hit — the
        // cached input text can be identical/near-identical while the underlying
        // facts a caller assembled (e.g. today's net worth vs. last week's) differ.
        // A cache hit that fails a `rejectOnLowGrounding` check falls through to a
        // live call below rather than being served stale/ungrounded — there is no
        // model to corrective-retry against for a cache hit, so "make a fresh call
        // instead" is the correct degrade, not "throw".
        let groundingScore: number | null = null;
        let hallucinationRisk: "unmeasured" | "low" | "medium" | "high" = "unmeasured";
        if (options.groundingContext) {
          const scored = this.grounding.score(JSON.stringify(cached.result), options.groundingContext);
          groundingScore = scored.score;
          hallucinationRisk = scored.risk;
        }

        const cacheRejected = options.rejectOnLowGrounding && hallucinationRisk === "high";
        if (!cacheRejected) {
          await this.logging.log({
            userId: options.userId,
            feature: options.feature,
            taskType,
            promptName: prompt.name,
            promptVersion: prompt.version,
            model: "cache",
            status: "OK",
            confidence: cached.confidence,
            retries: 0,
            latencyMs: Date.now() - startedAt,
            cacheHit: true,
            cacheType,
            redactedInput: budgetedInput,
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostUsd: 0,
            fallbackUsed: false,
            groundingScore,
            hallucinationRisk,
          });
          return this.toResult(cached, {
            model: "cache",
            promptName: prompt.name,
            promptVersion: prompt.version,
            startedAt,
            retries: 0,
            cacheHit: true,
            cacheType,
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostUsd: 0,
            routingReason: "task_default",
            fallbackUsed: false,
            groundingScore,
            hallucinationRisk,
          });
        }
        this.logger.warn(
          `Cached result for "${prompt.name}" (feature "${options.feature}") failed grounding verification against this call's context — ignoring cache and calling the model fresh.`,
        );
      }
    }

    // --- Dynamic model routing + fallback chain -------------------------------------
    const routing = this.router.resolveChain(taskType, budgetedInput, {
      complexityHint: options.complexityHint,
      maxLatencyMs: options.maxLatencyMs,
      maxCostUsd: options.maxCostUsd,
    });
    const temperature = routing.temperature;
    let chainStartIndex = 0; // once a candidate answers successfully, later corrective retries in this call start from that same candidate rather than re-trying earlier ones that already failed
    let routingReason = routing.reason;
    let fallbackUsed = false;

    const schemaDescription = this.validator.describe(envelope);
    const systemPrompt =
      `${prompt.template}\n\n` +
      `Respond with ONLY a single JSON object matching this shape, no other text:\n${schemaDescription}`;

    let lastIssues: string[] = [];
    let retries = 0;
    const maxAttempts = 1 + 2; // one initial attempt + up to 2 corrective retries (schema OR grounding), independent of GroqClient's own transport-level retries

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const messages =
        attempt === 0
          ? [
              { role: "system" as const, content: systemPrompt },
              { role: "user" as const, content: budgetedInput },
            ]
          : [
              { role: "system" as const, content: systemPrompt },
              { role: "user" as const, content: budgetedInput },
              { role: "assistant" as const, content: "(previous invalid response omitted)" },
              {
                role: "user" as const,
                content: `Your previous response did not match the required shape. Issues:\n${lastIssues.join("\n")}\n\nRespond again with ONLY corrected JSON.`,
              },
            ];

      const attemptStartedAt = Date.now();
      let completion: Awaited<ReturnType<GroqClient["chat"]>> | undefined;
      let modelUsed = routing.chain[chainStartIndex];

      for (let chainIdx = chainStartIndex; chainIdx < routing.chain.length; chainIdx++) {
        const candidateModel = routing.chain[chainIdx];
        try {
          completion = await this.groq.chat({
            model: candidateModel,
            messages,
            temperature,
            maxTokens: MAX_OUTPUT_TOKENS,
            jsonMode: true,
          });
          modelUsed = candidateModel;
          fallbackUsed = fallbackUsed || chainIdx > 0;
          if (chainIdx > 0) routingReason = "fallback_after_failure";
          chainStartIndex = chainIdx; // stick with whatever candidate just worked for any further attempts
          break;
        } catch (err) {
          this.routingStats.record(candidateModel, taskType, "ERROR", Date.now() - attemptStartedAt);
          const isLastCandidate = chainIdx === routing.chain.length - 1;
          if (!isLastCandidate) {
            this.logger.warn(
              `Model "${candidateModel}" unavailable for "${prompt.name}" (feature "${options.feature}") — falling back to next candidate in routing chain.`,
            );
            continue;
          }
          // Every candidate in the chain has now failed. GroqClient has already
          // exhausted its own transport-level retry budget for each of them before
          // throwing, so none of this is retried again here — retrying transport
          // failures is GroqClient's job; this loop's job was only to try the other
          // models the router offered.
          const errorMessage = err instanceof Error ? err.message : String(err);
          await this.logging.log({
            userId: options.userId,
            feature: options.feature,
            taskType,
            promptName: prompt.name,
            promptVersion: prompt.version,
            model: candidateModel,
            status: "ERROR",
            retries,
            latencyMs: Date.now() - startedAt,
            cacheHit: false,
            redactedInput: budgetedInput,
            errorMessage,
            promptTokens: 0,
            completionTokens: 0,
            estimatedCostUsd: 0,
            routingReason,
            fallbackUsed,
          });
          throw err;
        }
      }

      if (!completion) {
        // Unreachable in practice (the loop above either sets completion or throws),
        // but keeps TypeScript's control-flow analysis honest without a non-null
        // assertion.
        throw new AiValidationException(prompt.name, retries);
      }

      const attemptResult = this.validator.parse(envelope, completion.content);
      const attemptLatencyMs = Date.now() - attemptStartedAt;

      if (!attemptResult.ok || !attemptResult.data) {
        this.routingStats.record(modelUsed, taskType, "MALFORMED_FALLBACK", attemptLatencyMs);
        lastIssues = attemptResult.issues ?? ["Unknown validation failure"];
        retries++;
        this.logger.warn(`AI response for "${prompt.name}" failed validation (attempt ${attempt + 1}): ${lastIssues.join("; ")}`);
        continue;
      }

      // --- Grounding / hallucination check on a schema-valid response ---------------
      let groundingScore: number | null = null;
      let hallucinationRisk: "unmeasured" | "low" | "medium" | "high" = "unmeasured";
      let unmatchedNumbers: string[] = [];
      if (options.groundingContext) {
        const scored = this.grounding.score(JSON.stringify(attemptResult.data.result), options.groundingContext);
        groundingScore = scored.score;
        hallucinationRisk = scored.risk;
        unmatchedNumbers = scored.unmatchedNumbers;
      }

      const shouldRejectForGrounding =
        options.rejectOnLowGrounding && hallucinationRisk === "high" && attempt < maxAttempts - 1;

      if (shouldRejectForGrounding) {
        this.routingStats.record(modelUsed, taskType, "MALFORMED_FALLBACK", attemptLatencyMs);
        lastIssues = [
          `Your answer introduced figures not present in the given facts: ${unmatchedNumbers.join(", ") || "(unsupported content)"}. ` +
            "Only state figures that literally appear in the provided context.",
        ];
        retries++;
        this.logger.warn(
          `AI response for "${prompt.name}" (feature "${options.feature}") failed grounding verification (attempt ${attempt + 1}), retrying with a correction: ${lastIssues[0]}`,
        );
        continue;
      }

      // --- Success: log, cache, return -------------------------------------------
      this.routingStats.record(modelUsed, taskType, "OK", attemptLatencyMs);

      const promptTokens = completion.promptTokens;
      const completionTokens = completion.completionTokens;
      const estimatedCostUsd = this.tokenAccounting.estimateCostUsd(modelUsed, { promptTokens, completionTokens });

      if (options.rejectOnLowGrounding && hallucinationRisk === "high") {
        // Exhausted all corrective attempts and still ungrounded.
        await this.logging.log({
          userId: options.userId,
          feature: options.feature,
          taskType,
          promptName: prompt.name,
          promptVersion: prompt.version,
          model: modelUsed,
          status: "MALFORMED_FALLBACK",
          retries,
          latencyMs: Date.now() - startedAt,
          cacheHit: false,
          redactedInput: budgetedInput,
          rawOutput: completion.content,
          promptTokens,
          completionTokens,
          estimatedCostUsd,
          routingReason,
          fallbackUsed,
          groundingScore,
          hallucinationRisk,
          errorMessage: `Grounding rejected after ${retries} corrective ${retries === 1 ? "retry" : "retries"}`,
        });
        throw new AiGroundingException(prompt.name, unmatchedNumbers);
      }

      if (cacheable) {
        try {
          await this.cache.set(options.feature, prompt.name, prompt.version, budgetedInput, attemptResult.data);
        } catch (err) {
          this.logger.warn(
            `AiCacheService.set failed for "${prompt.name}" (feature "${options.feature}") — result was not cached: ${(err as Error).message}`,
          );
        }
      }
      if (semanticCacheEnabled) {
        try {
          await this.cache.setSemantic(options.feature, prompt.name, prompt.version, budgetedInput, attemptResult.data);
        } catch (err) {
          this.logger.warn(
            `AiCacheService.setSemantic failed for "${prompt.name}" (feature "${options.feature}") — result was not added to the semantic cache: ${(err as Error).message}`,
          );
        }
      }

      await this.logging.log({
        userId: options.userId,
        feature: options.feature,
        taskType,
        promptName: prompt.name,
        promptVersion: prompt.version,
        model: modelUsed,
        status: "OK",
        confidence: attemptResult.data.confidence,
        retries,
        latencyMs: Date.now() - startedAt,
        cacheHit: false,
        redactedInput: budgetedInput,
        rawOutput: completion.content,
        promptTokens,
        completionTokens,
        estimatedCostUsd,
        routingReason,
        fallbackUsed,
        groundingScore,
        hallucinationRisk,
      });
      return this.toResult(attemptResult.data, {
        model: modelUsed,
        promptName: prompt.name,
        promptVersion: prompt.version,
        startedAt,
        retries,
        cacheHit: false,
        cacheType: null,
        promptTokens,
        completionTokens,
        estimatedCostUsd,
        routingReason,
        fallbackUsed,
        groundingScore,
        hallucinationRisk,
      });
    }

    await this.logging.log({
      userId: options.userId,
      feature: options.feature,
      taskType,
      promptName: prompt.name,
      promptVersion: prompt.version,
      model: routing.chain[chainStartIndex],
      status: "MALFORMED_FALLBACK",
      retries,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
      redactedInput: budgetedInput,
      errorMessage: lastIssues.join("; "),
      promptTokens: 0,
      completionTokens: 0,
      estimatedCostUsd: 0,
      routingReason,
      fallbackUsed,
    });

    throw new AiValidationException(prompt.name, retries);
  }

  private toResult<T>(
    envelopeData: { result: T; confidence: number },
    meta: {
      model: string;
      promptName: string;
      promptVersion: number;
      startedAt: number;
      retries: number;
      cacheHit: boolean;
      cacheType: "exact" | "semantic" | null;
      promptTokens: number;
      completionTokens: number;
      estimatedCostUsd: number | null;
      routingReason: AiResult<T>["meta"]["routingReason"];
      fallbackUsed: boolean;
      groundingScore: number | null;
      hallucinationRisk: "unmeasured" | "low" | "medium" | "high";
    },
  ): AiResult<T> {
    return {
      data: envelopeData.result,
      confidence: envelopeData.confidence,
      groundingScore: meta.groundingScore,
      hallucinationRisk: meta.hallucinationRisk,
      meta: {
        model: meta.model,
        promptName: meta.promptName,
        promptVersion: meta.promptVersion,
        latencyMs: Date.now() - meta.startedAt,
        retries: meta.retries,
        cacheHit: meta.cacheHit,
        cacheType: meta.cacheType,
        promptTokens: meta.promptTokens,
        completionTokens: meta.completionTokens,
        totalTokens: meta.promptTokens + meta.completionTokens,
        estimatedCostUsd: meta.estimatedCostUsd,
        routingReason: meta.routingReason,
        fallbackUsed: meta.fallbackUsed,
      },
    };
  }
}
