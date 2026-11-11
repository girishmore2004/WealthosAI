// Comma-separated list support so a single env var can carry the primary Vercel
// production URL plus any extra origins.
function parseOriginList(value: string | undefined): string[] {
  if (!value) return [];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
}

const DEFAULT_MODEL_PRICING: Record<string, ModelPricing> = {
  "openai/gpt-oss-20b": {
    promptPer1M: 0.075,
    completionPer1M: 0.3,
  },
  "openai/gpt-oss-120b": {
    promptPer1M: 0.15,
    completionPer1M: 0.6,
  },
  "llama-3.1-8b-instant": {
    promptPer1M: 0.05,
    completionPer1M: 0.08,
  },
  "llama-3.3-70b-versatile": {
    promptPer1M: 0.59,
    completionPer1M: 0.79,
  },
};

function loadModelPricing(): Record<string, ModelPricing> {
  const raw = process.env.AI_MODEL_PRICING_JSON;

  if (!raw) {
    return DEFAULT_MODEL_PRICING;
  }

  try {
    const overrides = JSON.parse(raw);

    return {
      ...DEFAULT_MODEL_PRICING,
      ...overrides,
    };
  } catch {
    return DEFAULT_MODEL_PRICING;
  }
}

export default () => ({
  port: parseInt(process.env.API_PORT ?? "4000", 10),

  databaseUrl: process.env.DATABASE_URL,

  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",

  sessionTtlSeconds: parseInt(
    process.env.SESSION_TTL_SECONDS ?? "2592000",
    10,
  ),

  webUrl: process.env.WEB_URL ?? "http://localhost:3000",

  corsExtraOrigins: parseOriginList(
    process.env.CORS_EXTRA_ORIGINS,
  ),

  vercelPreviewPrefix:
    process.env.VERCEL_PREVIEW_PREFIX ?? "",

  crossSiteCookies: process.env.CROSS_SITE_COOKIES
    ? process.env.CROSS_SITE_COOKIES === "true"
    : process.env.NODE_ENV === "production",

  otpAdapter: process.env.OTP_ADAPTER ?? "mock",

  demoLoginEmails: (
    process.env.DEMO_LOGIN_EMAILS ?? "demo@wealthos.ai"
  )
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),

  ocrAdapter: process.env.OCR_ADAPTER ?? "tesseract",

  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail:
      process.env.OTP_FROM_EMAIL ??
      "WealthOS AI <onboarding@resend.dev>",
  },

  brevo: {
    apiKey: process.env.BREVO_API_KEY ?? "",
    senderEmail: process.env.BREVO_SENDER_EMAIL ?? "",
    senderName:
      process.env.BREVO_SENDER_NAME ?? "WealthOS AI",
  },

  ai: {
    // Provider selection.
    // OpenAI is primary when configured.
    // Groq remains an independent fallback.

    primaryProvider: (
      process.env.AI_PRIMARY_PROVIDER ??
      (process.env.OPENAI_API_KEY ? "openai" : "groq")
    ).toLowerCase(),

    // OPENAI CONFIGURATION

    openAiApiKey:
      process.env.OPENAI_API_KEY ?? "",

    openAiApiBaseUrl:
      process.env.OPENAI_API_BASE_URL ??
      "https://api.openai.com/v1",

    openAiSmallModel:
      process.env.OPENAI_SMALL_MODEL ??
      "gpt-4o-mini",

    openAiLargeModel:
      process.env.OPENAI_LARGE_MODEL ??
      "gpt-4o",

    // GROQ CONFIGURATION

    groqApiKey:
      process.env.GROQ_API_KEY ?? "",

    groqApiBaseUrl:
      process.env.GROQ_API_BASE_URL ??
      "https://api.groq.com/openai/v1",

    smallModel:
      process.env.GROQ_SMALL_MODEL ??
      "openai/gpt-oss-20b",

    largeModel:
      process.env.GROQ_LARGE_MODEL ??
      "openai/gpt-oss-120b",

    fallbackModel:
      process.env.GROQ_FALLBACK_MODEL ?? "",

    // PERFORMANCE

    requestTimeoutMs: parseInt(
      process.env.AI_REQUEST_TIMEOUT_MS ?? "20000",
      10,
    ),

    maxRetries: parseInt(
      process.env.AI_MAX_RETRIES ?? "2",
      10,
    ),

    cacheTtlSeconds: parseInt(
      process.env.AI_CACHE_TTL_SECONDS ?? "900",
      10,
    ),

    semanticCacheThreshold: parseFloat(
      process.env.AI_SEMANTIC_CACHE_THRESHOLD ?? "0.94",
    ),

    // TOKEN COST ACCOUNTING

    modelPricing: loadModelPricing(),
  },
});
