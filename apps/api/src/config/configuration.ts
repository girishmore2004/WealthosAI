// Comma-separated list support so a single env var can carry the primary Vercel
// production URL plus any extra origins (a custom domain, a staging site, etc.)
// without needing a code change per origin. Empty/whitespace entries are dropped.
function parseOriginList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
}

interface ModelPricing {
  /** USD per 1,000,000 prompt (input) tokens. */
  promptPer1M: number;
  /** USD per 1,000,000 completion (output) tokens. */
  completionPer1M: number;
}

// Approximate list-price figures as of this writing, NOT pulled live from Groq — used
// by TokenAccountingService for exact post-call cost accounting, and as a rough
// per-call estimate by ModelRouterService's budget-aware routing decisions
// pre-call. Override/extend via AI_MODEL_PRICING_JSON (a JSON object merged over these
// defaults) if Groq's actual pricing has changed, or if GROQ_SMALL_MODEL /
// GROQ_LARGE_MODEL / GROQ_FALLBACK_MODEL is pointed at a model string not listed here
// — an unpriced model isn't billed as $0, TokenAccountingService.estimateCostUsd
// returns null for it instead (see that class).
const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "llama-3.1-8b-instant": { promptPer1M: 0.05, completionPer1M: 0.08 },
  "llama-3.3-70b-versatile": { promptPer1M: 0.59, completionPer1M: 0.79 },
};

function loadModelPricing(): Record<string, ModelPricing> {
  if (!process.env.AI_MODEL_PRICING_JSON) return DEFAULT_MODEL_PRICING;
  try {
    const overrides = JSON.parse(process.env.AI_MODEL_PRICING_JSON);
    return { ...DEFAULT_MODEL_PRICING, ...overrides };
  } catch {
    // Malformed override must never crash boot — fall back to the safe defaults and
    // let GET /ai/health's byModel breakdown make a $0/null-cost model obvious enough
    // to notice and fix the env var.
    return DEFAULT_MODEL_PRICING;
  }
}

export default () => ({
  port: parseInt(process.env.API_PORT ?? "4000", 10),
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  sessionTtlSeconds: parseInt(process.env.SESSION_TTL_SECONDS ?? "2592000", 10),
  webUrl: process.env.WEB_URL ?? "http://localhost:3000",
  // Extra allowed CORS origins beyond WEB_URL — e.g. a custom domain, comma-separated.
  corsExtraOrigins: parseOriginList(process.env.CORS_EXTRA_ORIGINS),
  // When true, also allow any https://*.vercel.app origin whose subdomain starts with
  // this prefix (Vercel's per-branch/PR preview deployments get a random suffix on the
  // project name, e.g. wealthos-ai-git-feature-x-yourteam.vercel.app). Leave unset to
  // disable preview-origin matching entirely (the safer default for production).
  vercelPreviewPrefix: process.env.VERCEL_PREVIEW_PREFIX ?? "",
  // Cross-site cookies (backend on Render, frontend on Vercel — two different eTLD+1
  // domains) require `SameSite=None; Secure`, which only works over HTTPS. Same-site
  // deployments (or plain local dev over http) should stay on `SameSite=Lax` since
  // `None` needs `Secure` and local http will silently drop the cookie otherwise.
  // Defaults to true whenever NODE_ENV=production, since that's the common case for
  // this stack; override explicitly for a same-domain production deployment.
  crossSiteCookies: process.env.CROSS_SITE_COOKIES
    ? process.env.CROSS_SITE_COOKIES === "true"
    : process.env.NODE_ENV === "production",
  otpAdapter: process.env.OTP_ADAPTER ?? "mock",
  // NEW: selects the OCR implementation Documents uses — see
  // documents/adapters/ocr-adapter.factory.ts. "tesseract" (default) is the real,
  // free/OSS OCR engine; "mock" keeps the deterministic zero-dependency placeholder
  // (useful for tests/CI or an environment that wants to skip real OCR processing).
  ocrAdapter: process.env.OCR_ADAPTER ?? "tesseract",
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.OTP_FROM_EMAIL ?? "WealthOS AI <onboarding@resend.dev>",
  },
  ai: {
    groqApiKey: process.env.GROQ_API_KEY ?? "",
    groqApiBaseUrl: process.env.GROQ_API_BASE_URL ?? "https://api.groq.com/openai/v1",
    smallModel: process.env.GROQ_SMALL_MODEL ?? "llama-3.1-8b-instant",
    largeModel: process.env.GROQ_LARGE_MODEL ?? "llama-3.3-70b-versatile",
    // A distinct third model string, tried only after BOTH the small and large models
    // have failed for a given call — see model-router.service.ts's
    // RoutingDecision.chain and AiGatewayService's fallback loop. Point this at a
    // different provider-hosted model as a last resort if desired. Left unset by
    // default, in which case the chain falls back to the small model a second time
    // rather than producing an empty/undefined final candidate.
    fallbackModel: process.env.GROQ_FALLBACK_MODEL ?? "",
    requestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "20000", 10),
    maxRetries: parseInt(process.env.AI_MAX_RETRIES ?? "2", 10),
    cacheTtlSeconds: parseInt(process.env.AI_CACHE_TTL_SECONDS ?? "900", 10),
    // Cosine-similarity floor (0-1) for AiCacheService.getSemantic's fuzzy cache
    // lookups — see semantic-similarity.util.ts. Kept high by default: a semantic
    // cache serving a wrong answer is worse than a cache miss.
    semanticCacheThreshold: parseFloat(process.env.AI_SEMANTIC_CACHE_THRESHOLD ?? "0.94"),
    modelPricing: loadModelPricing(),
  },
});
