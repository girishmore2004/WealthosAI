import { z } from "zod";

// The five task types AiGatewayService supports. This is deliberately a closed set —
// ModelRouter switches on it to pick small-vs-large model, and AiLoggingService writes
// it verbatim to AiInteractionLog.taskType. Add a new one here (and in ModelRouter)
// before using it anywhere, don't pass ad-hoc strings.
export type AiTaskType = "classification" | "extraction" | "generation" | "summarization" | "ranking";

/** Caller-declared or router-inferred complexity of a single call. Feeds
 * ModelRouterService's candidate selection (see model-router.service.ts) alongside
 * accuracy/latency/budget signals — a caller that knows its own prompt is "just pick
 * one of 3 labels" vs. "synthesize a multi-paragraph grounded answer" should say so
 * rather than making the router guess purely from input length. When omitted, the
 * router falls back to a length/structure heuristic. */
export type AiComplexityHint = "low" | "medium" | "high";

/** Why the router ended up on the model it did — purely for logging/debugging, never
 * branched on by callers. Surfaced on AiResult.meta.routingReason. */
export type RoutingReason =
  | "task_default"
  | "complexity_upgrade"
  | "complexity_downgrade"
  | "budget_downgrade"
  | "latency_downgrade"
  | "accuracy_downgrade"
  | "fallback_after_failure";

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

  // --- Dynamic routing inputs (ModelRouterService) --------------------------------
  /** How hard this specific call is, if the caller knows better than a length
   * heuristic can (e.g. RAG query rewrite is always "low" even for a long question;
   * Scenario Studio's explanation is "high" even for a short facts block). */
  complexityHint?: AiComplexityHint;
  /** Soft wall-clock budget for this call in ms. The router will avoid a candidate
   * model whose recent observed p95 latency exceeds this, if a faster candidate for
   * the same task type exists. This is advisory for model *selection*, not a hard
   * request timeout — GroqClient's own requestTimeoutMs still governs the actual
   * abort. */
  maxLatencyMs?: number;
  /** Soft per-call cost ceiling in USD. If the cheapest candidate for this task type
   * would still be estimated to exceed this, the router picks the cheapest available
   * candidate anyway (never refuses to serve the call) but flags routingReason so
   * it's visible in logs. Primarily used as a downgrade signal: when set, the router
   * prefers a cheaper model over a marginally-more-capable one if both can plausibly
   * satisfy the task type. */
  maxCostUsd?: number;

  // --- Semantic cache ---------------------------------------------------------------
  /** Opt into (or explicitly out of) similarity-based cache lookups on top of the
   * existing exact-match cache. Defaults to true whenever `cacheable` resolves true
   * for classification/extraction/ranking (the task types where "close enough" input
   * should plausibly produce the same answer); defaults to false for
   * generation/summarization even if cacheable is forced true, since prose composition
   * is exactly the case where two *similar but not identical* prompts often should NOT
   * collapse to the same cached text. Pass explicitly to override either way. */
  semanticCache?: boolean;
  /** Cosine-similarity threshold (0-1) above which a semantically cached entry is
   * considered a hit. Defaults to config `ai.semanticCacheThreshold` (0.94) — high on
   * purpose: a semantic cache serving a wrong answer is worse than a cache miss. */
  semanticCacheThreshold?: number;

  // --- Grounding / hallucination detection -----------------------------------------
  /** The deterministic facts/context this call's output must not contradict — e.g. the
   * exact facts-text block a coach's answer-composer assembled from real numbers, or
   * the retrieved chunks a RAG synthesis step was given. When provided, the gateway
   * computes a groundingScore (see grounding.service.ts) independent of the model's
   * own self-reported confidence, and — if `rejectOnLowGrounding` is set — treats a
   * low score as a correctable failure the same way a schema-validation failure is
   * treated (one corrective retry, then a typed exception). Omit for calls with no
   * fixed ground truth to check against (e.g. free-form classification of user text);
   * grounding is meaningless there and the gateway will not attempt to score it. */
  groundingContext?: string;
  /** When true and `groundingContext` is set, a groundingScore below the "high risk"
   * bucket (see GroundingService) triggers one corrective retry (telling the model
   * which figures it introduced aren't in the given facts) before throwing
   * AiGroundingException. When false (default), a low score is still computed and
   * logged/returned for the caller's own UI/handling, but never blocks the response —
   * safe default for existing callers that don't yet check `hallucinationRisk`. */
  rejectOnLowGrounding?: boolean;
}

/** Every AiGatewayService call returns this shape. `confidence` is explained in
 * AiGatewayService's top-of-file doc comment — short version: it is the model's own
 * self-report, not a calibrated statistic, and callers should treat it as a rough
 * signal for UI display (e.g. "low confidence" badge), not as a probability. */
export interface AiResult<T> {
  data: T;
  confidence: number;
  /** 0-1, or null when no `groundingContext` was supplied for this call (not "0 = fully
   * hallucinated" — null means "not measured", 0 means "measured and found nothing in
   * common with the given facts"). See grounding.service.ts. */
  groundingScore: number | null;
  /** Coarse bucket derived from groundingScore for easy UI branching
   * (e.g. show a "verify this" badge on "medium"/"high"). Always "unmeasured" when
   * groundingContext wasn't supplied. */
  hallucinationRisk: "unmeasured" | "low" | "medium" | "high";
  meta: {
    model: string;
    promptName: string;
    promptVersion: number;
    latencyMs: number;
    retries: number;
    cacheHit: boolean;
    /** "exact" | "semantic" | null (no cache hit at all) — which cache path served
     * this result, for observability into how much the semantic cache is pulling its
     * weight beyond the pre-existing exact-match path. */
    cacheType: "exact" | "semantic" | null;
    /** Real usage as reported by Groq's own `usage` block on the response that
     * ultimately produced this result — 0/0 on a cache hit (no call was made). This is
     * the actual billed token count, distinct from TokenBudgetService's pre-call
     * ~4-chars-per-token *estimate*, which exists only to decide whether to trim input
     * before sending, not to account cost. */
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    /** Computed from real usage above against config `ai.modelPricing` for whichever
     * model actually answered. 0 on a cache hit. Best-effort: if the model isn't in
     * the pricing table (e.g. a brand-new GROQ_LARGE_MODEL override nobody has priced
     * yet), this is null rather than a silently-wrong number. */
    estimatedCostUsd: number | null;
    /** Which candidate model in the router's chain actually served this call, and
     * whether that required falling back off the router's first choice. See
     * model-router.service.ts and AiGatewayService.runStructured's fallback loop. */
    routingReason: RoutingReason;
    fallbackUsed: boolean;
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
