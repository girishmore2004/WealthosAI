import { CanActivate, ExecutionContext, HttpException, HttpStatus, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { RedisService } from "../../redis/redis.service";
import { RATE_LIMIT_KEY, RateLimitOptions } from "../decorators/rate-limit.decorator";

// Generalizes the same Redis incr-with-expiry pattern AuthService already uses for OTP
// requests (see auth.service.ts) into a reusable guard any route can opt into with
// @RateLimit(limit, windowSeconds). Must run AFTER SessionAuthGuard in the guard list —
// it keys off request.user, which SessionAuthGuard attaches.
//
// Routes with no @RateLimit() metadata are allowed through untouched (opt-in, not a
// global throttle) — see README "Rate limiting" for which routes currently opt in and
// why the rest don't yet.
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private redis: RedisService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const options = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT_KEY, context.getHandler());
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request & { user?: { id: string } }>();
    const userId = request.user?.id;
    // No authenticated user yet (e.g. guard misordering) — fail closed on identity but
    // don't block the request here; SessionAuthGuard is responsible for rejecting
    // unauthenticated requests. Falling back to IP keeps this guard usable standalone.
    const identity = userId ?? request.ip ?? "anonymous";

    const route = `${context.getClass().name}.${context.getHandler().name}`;
    const key = `ratelimit:${route}:${identity}`;

    const count = await this.redis.incrWithExpiry(key, options.windowSeconds);
    if (count > options.limit) {
      throw new HttpException(
        `Too many requests to this endpoint. Try again in a few minutes.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return true;
  }
}
