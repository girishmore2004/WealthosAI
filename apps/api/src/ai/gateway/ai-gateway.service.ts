import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { GroqClient } from "../groq/groq.client";
import { ModelRouterService } from "./model-router.service";
import { SchemaValidatorService } from "./schema-validator.service";
import { TokenBudgetService } from "./token-budget.service";
import { RedactionService } from "./redaction.service";
import { PromptRegistryService } from "../ops/prompt-registry.service";
import { AiLoggingService } from "../ops/ai-logging.service";
import { AiCacheService } from "../ops/ai-cache.service";
import { AiValidationException } from "../exceptions/ai.exceptions";
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
// every other AI feature (Coach, RAG, Scenario Studio, Copilot Ingestion, etc., as
// they land in later phases) calls through here rather than hitting GroqClient
// directly, so redaction/budgeting/caching/logging/validation is applied uniformly
// regardless of which feature is asking.
//
// Pipeline for every call: redact free text -> trim to token budget -> check cache
// (if cacheable) -> resolve active prompt + pick model via ModelRouterService -> call
// Groq, asking for a JSON object matching the caller's schema wrapped in a
// self-reported confidence envelope -> validate with SchemaValidatorService; on
// failure, retry with the validation issues fed back to the model as a correction
// instruction (up to config.ai.maxRetries times) -> log the interaction -> write cache
// on success -> return.
//
// Two resilience properties this pipeline guarantees, both load-bearing for callers'
// documented `catch (e) { if (e instanceof AiUnavailableException) ...fallback... }`
// pattern (see ai.exceptions.ts and every feature under ai/*):
//   1. A transport-level failure (GroqClient throwing AiUnavailableException after
//      exhausting its own retries) is always logged with status "ERROR" before it is
//      rethrown — AiInteractionLog/recentStats() must never under-report failures just
//      because the model never actually answered. This call is NOT itself retried here
//      (GroqClient already exhausted its own transport retry budget); the gateway's
//      retry loop below is reserved for *validation* failures on responses that did
//      come back.
//   2. AiCacheService being unavailable (e.g. a Redis blip) must never fail an AI call
//      outright — same fail-open philosophy AiLoggingService already documents for
//      logging. A cache read/write error is logged as a warning and the call proceeds
//      as if it were a cache miss.
//
// A note on `confidence`: it is the model's own self-report (see
// ai-gateway.types.ts#withConfidence), not a calibrated probability computed from
// logprobs or an ensemble. Groq's chat completions endpoint doesn't expose the kind of
// token-level logprob access this app would need to compute a real confidence score,
// and building a separate calibration model is out of scope for this phase. Treat it
// as "how sure did the model say it was", useful for a UI badge, not as a statistic
// you'd do further math on. This limitation is intentional and documented rather than
// hidden — see README "Phase 10".
@Injectable()
export class AiGatewayService {
  private readonly logger = new Logger(AiGatewayService.name);

  constructor(
    private groq: GroqClient,
    private router: ModelRouterService,
    private validator: SchemaValidatorService,
    private tokenBudget: TokenBudgetService,
    private redaction: RedactionService,
    private prompts: PromptRegistryService,
    private logging: AiLoggingService,
    private cache: AiCacheService,
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

  private async runStructured<TSchema extends z.ZodTypeAny>(
    taskType: AiTaskType,
    envelope: TSchema,
    rawInput: string,
    options: AiCallOptions,
  ): Promise<AiResult<z.infer<TSchema>["result"]>> {
    const startedAt = Date.now();
    const cacheable = options.cacheable ?? this.defaultCacheable(taskType);

    const { text: redactedInput, redactedTypes } = this.redaction.redact(rawInput);
    const { text: budgetedInput, wasTrimmed } = this.tokenBudget.trimToBudget(redactedInput, MAX_CONTEXT_TOKENS);

    // These don't go into AiInteractionLog (that row shape is owned by
    // AiLoggingService, out of scope for this feature) but they're worth surfacing to
    // stdout/stderr — silently trimming context can degrade an answer in a way that's
    // otherwise invisible to whoever is debugging a "the AI gave a weird answer"
    // report, and knowing *that* PII was redacted (never the value) is useful audit
    // signal even without a persisted row.
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
    const model = this.router.modelFor(taskType);
    const temperature = this.router.temperatureFor(taskType);

    if (cacheable) {
      // Fail-open: a cache outage must degrade to "always call Groq", never to "the AI
      // feature is down". Mirrors AiLoggingService.log()'s own fail-open contract.
      let cached: z.infer<TSchema> | null = null;
      try {
        cached = await this.cache.get<z.infer<TSchema>>(
          options.feature,
          prompt.name,
          prompt.version,
          budgetedInput,
        );
      } catch (err) {
        this.logger.warn(
          `AiCacheService.get failed for "${prompt.name}" (feature "${options.feature}") — proceeding without cache: ${(err as Error).message}`,
        );
      }

      if (cached) {
        await this.logging.log({
          userId: options.userId,
          feature: options.feature,
          taskType,
          promptName: prompt.name,
          promptVersion: prompt.version,
          model,
          status: "OK",
          confidence: cached.confidence,
          retries: 0,
          latencyMs: Date.now() - startedAt,
          cacheHit: true,
          redactedInput: budgetedInput,
        });
        return this.toResult(cached, { model, promptName: prompt.name, promptVersion: prompt.version, startedAt, retries: 0, cacheHit: true });
      }
    }

    const schemaDescription = this.validator.describe(envelope);
    const systemPrompt =
      `${prompt.template}\n\n` +
      `Respond with ONLY a single JSON object matching this shape, no other text:\n${schemaDescription}`;

    let lastIssues: string[] = [];
    let retries = 0;
    const maxAttempts = 1 + 2; // one initial attempt + up to 2 corrective retries, independent of GroqClient's own transport-level retries

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

      let completion: Awaited<ReturnType<GroqClient["chat"]>>;
      try {
        completion = await this.groq.chat({
          model,
          messages,
          temperature,
          maxTokens: MAX_OUTPUT_TOKENS,
          jsonMode: true,
        });
      } catch (err) {
        // GroqClient has already exhausted its own transport-level retry budget
        // (see groq.client.ts's maxRetries loop) before this throws, so this is NOT
        // retried again here — retrying transport failures is that class's job, not
        // this one's. Previously this exception propagated straight past this method
        // uncaught, which meant AiInteractionLog never got a row for outright Groq
        // failures (only for "OK" and "MALFORMED_FALLBACK") even though the
        // AiInteractionStatus.ERROR enum value exists specifically for this case, and
        // GET /ai/health's errorRate silently under-counted real outages as a result.
        const errorMessage = err instanceof Error ? err.message : String(err);
        await this.logging.log({
          userId: options.userId,
          feature: options.feature,
          taskType,
          promptName: prompt.name,
          promptVersion: prompt.version,
          model,
          status: "ERROR",
          retries,
          latencyMs: Date.now() - startedAt,
          cacheHit: false,
          redactedInput: budgetedInput,
          errorMessage,
        });
        // Rethrow the original error unchanged (still AiUnavailableException in the
        // normal case) so every calling feature's existing
        // `catch (e) { if (e instanceof AiUnavailableException) ...fallback... }`
        // pattern keeps working exactly as documented, with no signature/behavior
        // change visible to callers beyond "the failure is now also logged".
        throw err;
      }

      const attemptResult = this.validator.parse(envelope, completion.content);
      if (attemptResult.ok && attemptResult.data) {
        if (cacheable) {
          try {
            await this.cache.set(options.feature, prompt.name, prompt.version, budgetedInput, attemptResult.data);
          } catch (err) {
            this.logger.warn(
              `AiCacheService.set failed for "${prompt.name}" (feature "${options.feature}") — result was not cached: ${(err as Error).message}`,
            );
          }
        }
        await this.logging.log({
          userId: options.userId,
          feature: options.feature,
          taskType,
          promptName: prompt.name,
          promptVersion: prompt.version,
          model: completion.model,
          status: "OK",
          confidence: attemptResult.data.confidence,
          retries,
          latencyMs: Date.now() - startedAt,
          cacheHit: false,
          redactedInput: budgetedInput,
          rawOutput: completion.content,
        });
        return this.toResult(attemptResult.data, {
          model: completion.model,
          promptName: prompt.name,
          promptVersion: prompt.version,
          startedAt,
          retries,
          cacheHit: false,
        });
      }

      lastIssues = attemptResult.issues ?? ["Unknown validation failure"];
      retries++;
      this.logger.warn(`AI response for "${prompt.name}" failed validation (attempt ${attempt + 1}): ${lastIssues.join("; ")}`);
    }

    await this.logging.log({
      userId: options.userId,
      feature: options.feature,
      taskType,
      promptName: prompt.name,
      promptVersion: prompt.version,
      model,
      status: "MALFORMED_FALLBACK",
      retries,
      latencyMs: Date.now() - startedAt,
      cacheHit: false,
      redactedInput: budgetedInput,
      errorMessage: lastIssues.join("; "),
    });

    throw new AiValidationException(prompt.name, retries);
  }

  private toResult<T>(
    envelopeData: { result: T; confidence: number },
    meta: { model: string; promptName: string; promptVersion: number; startedAt: number; retries: number; cacheHit: boolean },
  ): AiResult<T> {
    return {
      data: envelopeData.result,
      confidence: envelopeData.confidence,
      meta: {
        model: meta.model,
        promptName: meta.promptName,
        promptVersion: meta.promptVersion,
        latencyMs: Date.now() - meta.startedAt,
        retries: meta.retries,
        cacheHit: meta.cacheHit,
      },
    };
  }
}
