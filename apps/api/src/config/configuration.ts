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
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    fromEmail: process.env.OTP_FROM_EMAIL ?? "WealthOS AI <onboarding@resend.dev>",
  },
  ai: {
    groqApiKey: process.env.GROQ_API_KEY ?? "",
    groqApiBaseUrl: process.env.GROQ_API_BASE_URL ?? "https://api.groq.com/openai/v1",
    smallModel: process.env.GROQ_SMALL_MODEL ?? "llama-3.1-8b-instant",
    largeModel: process.env.GROQ_LARGE_MODEL ?? "llama-3.3-70b-versatile",
    requestTimeoutMs: parseInt(process.env.AI_REQUEST_TIMEOUT_MS ?? "20000", 10),
    maxRetries: parseInt(process.env.AI_MAX_RETRIES ?? "2", 10),
    cacheTtlSeconds: parseInt(process.env.AI_CACHE_TTL_SECONDS ?? "900", 10),
  },
});
