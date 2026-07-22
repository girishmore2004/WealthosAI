import { z } from "zod";

// The five task types AiGatewayService supports. This is deliberately a closed set —
// ModelRouter switches on it to pick small-vs-large model, and AiLoggingService writes
// it verbatim to AiInteractionLog.taskType. Add a new one here (and in ModelRouter)
// before using it anywhere, don't pass ad-hoc strings.
export type AiTaskType = "classification" | "extraction" | "generation" | "summarization" | "ranking";

export interface AiCallOptions {
  /** Free-text label for AiInteractionLog.feature, e.g. "coach.explain". Not validated
   * against a fixed enum on purpose — this file is infrastructure, features that don't
   * exist yet shouldn't need to modify it to register a name. */
  feature: string;
  /** Registered prompt name (see PromptRegistryService). */
  promptName: string;
  /** The user this call is on behalf of, for logging/rate-limit/ownership purposes.
   * Optional because some calls (e.g. a health self-test) aren't user-scoped. */
  userId?: string;
  /** Whether a successful result may be served from / written to AiCacheService.
   * Defaults to true for classification/extraction/ranking (deterministic-ish tasks),
   * false for generation/summarization (usually meant to feel fresh each time) — see
   * AiGatewayService.defaultCacheable(). Pass explicitly to override either way. */
  cacheable?: boolean;
}

/** Every AiGatewayService call returns this shape. `confidence` is explained in
 * AiGatewayService's top-of-file doc comment — short version: it is the model's own
 * self-report, not a calibrated statistic, and callers should treat it as a rough
 * signal for UI display (e.g. "low confidence" badge), not as a probability. */
export interface AiResult<T> {
  data: T;
  confidence: number;
  meta: {
    model: string;
    promptName: string;
    promptVersion: number;
    latencyMs: number;
    retries: number;
    cacheHit: boolean;
  };
}

// Every structured call wraps the caller's schema in this envelope so the model always
// self-reports a confidence alongside the actual payload, rather than confidence being
// bolted on separately after the fact.
export function withConfidence<T extends z.ZodTypeAny>(schema: T) {
  return z.object({
    result: schema,
    confidence: z
      .number()
      .min(0)
      .max(1)
      .describe("Your own confidence in this result, from 0 (guessing) to 1 (certain), given only the provided input."),
  });
}

export const classificationEnvelope = <T extends [string, ...string[]]>(labels: T) =>
  withConfidence(z.object({ label: z.enum(labels) }));

export const rankingEnvelope = withConfidence(
  z.object({
    orderedIndices: z.array(z.number().int().min(0)).describe("Item indices, best-first, per the given criterion."),
    rationale: z.string().max(500),
  }),
);

export const summaryEnvelope = withConfidence(z.object({ summary: z.string() }));

export const generationEnvelope = withConfidence(z.object({ text: z.string() }));
