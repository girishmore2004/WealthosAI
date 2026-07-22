import { SetMetadata } from "@nestjs/common";

export const RATE_LIMIT_KEY = "rateLimit";

export interface RateLimitOptions {
  /** Max requests allowed per window, per authenticated user, per route. */
  limit: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

// Usage: @RateLimit(20, 3600) @UseGuards(SessionAuthGuard, RateLimitGuard)
// Order matters — SessionAuthGuard must run first so RateLimitGuard can key off
// request.user. Route-scoped rather than global so different endpoints (cheap CRUD vs.
// an eventual AI call) can carry very different limits without a shared config object.
export const RateLimit = (limit: number, windowSeconds: number) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds } satisfies RateLimitOptions);
