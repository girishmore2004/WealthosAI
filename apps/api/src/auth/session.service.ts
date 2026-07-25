import { Injectable, Logger } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

// 256 bits of cryptographically random entropy — well above the ~128-bit floor generally
// considered sufficient for a bearer session token, and a real step up from the previous
// scheme (the session cookie held the Prisma-generated `session.id` cuid directly, i.e.
// the DB primary key doubled as the secret bearer credential — a coupling smell: cuids
// are only partially random (timestamp + counter + host fingerprint + random block), and
// using a row's own PK as a secret makes it unsafe to ever log/display a session id for
// support/admin tooling). OTP codes in this codebase are already correctly hashed at
// rest (see auth.service.ts's `hashCode`); this brings session tokens to the same
// standard: only SHA-256(token) is ever persisted, the raw token is returned exactly
// once to the caller and is never logged.
const SESSION_TOKEN_BYTES = 32;

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export interface ResolvedSession {
  userId: string;
  sessionId: string;
}

@Injectable()
export class SessionService {
  private readonly logger = new Logger("SessionService");

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private config: ConfigService,
  ) {}

  private get ttlSeconds() {
    return this.config.get<number>("sessionTtlSeconds")!;
  }

  private get legacyIdFallbackEnabled() {
    return this.config.get<boolean>("session.legacyIdFallback") ?? true;
  }

  // --- Redis wrappers: fail open (fall through to Postgres) on infra failure ----------
  // SessionAuthGuard calls resolveToken() on essentially every authenticated API request
  // in the app. If Redis briefly errors, the original design already had a Postgres
  // fallback for a cache *miss* — but a raw exception from Redis (rather than a clean
  // miss) would propagate up as a 500 instead of falling through. These wrappers make a
  // Redis outage degrade to "every request pays a Postgres read" instead of "every
  // authenticated request in the app fails."
  private async safeGet(key: string, context: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; falling back to Postgres. ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSet(key: string, value: string, ttlSeconds: number, context: string): Promise<void> {
    try {
      await this.redis.set(key, value, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; skipping cache write. ${(err as Error).message}`);
    }
  }

  private async safeDel(key: string, context: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; skipping cache delete. ${(err as Error).message}`);
    }
  }

  // Creates a session row plus a fresh opaque bearer token. Only SHA-256(token) is ever
  // persisted (Postgres `tokenHash` column, Redis cache key). The raw token is returned
  // once, to the caller (AuthController), which sets it as the session cookie value; it
  // is never logged and never stored anywhere in raw form.
  async createSession(userId: string, userAgent?: string, ipAddress?: string) {
    const rawToken = randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);

    const session = await this.prisma.client.session.create({
      data: { userId, expiresAt, userAgent, ipAddress, tokenHash },
    });

    await this.safeSet(`session:${tokenHash}`, `${userId}:${session.id}`, this.ttlSeconds, "session cache write on create");

    return { session, rawToken };
  }

  // Resolves a raw bearer token (straight from the cookie) to { userId, sessionId }.
  // Redis-first with a Postgres fallback + cache repopulation on miss. Returns null for
  // anything invalid/expired/revoked — callers (SessionAuthGuard) convert that uniformly
  // into a 401; there is no separate error path that would let a caller distinguish
  // "malformed token" from "expired" from "revoked" from "never existed."
  async resolveToken(rawToken: string): Promise<ResolvedSession | null> {
    const tokenHash = hashToken(rawToken);

    const cached = await this.safeGet(`session:${tokenHash}`, "session lookup (cache)");
    if (cached) {
      const [userId, sessionId] = cached.split(":");
      return { userId, sessionId };
    }

    const session = await this.prisma.client.session.findUnique({ where: { tokenHash } });
    if (session && !session.revoked && session.expiresAt >= new Date()) {
      await this.safeSet(`session:${tokenHash}`, `${session.userId}:${session.id}`, this.ttlSeconds, "session cache repopulate");
      return { userId: session.userId, sessionId: session.id };
    }

    // --- TEMPORARY MIGRATION SHIM -----------------------------------------------------
    // Sessions created before the opaque-token change have `tokenHash = NULL` and their
    // cookie carries the *legacy* value — the session row's own `id` — as the bearer
    // credential. This path preserves those already-logged-in users across the deploy
    // instead of forcing every active session to re-authenticate immediately. It is
    // read-only (never writes to the new tokenHash-keyed cache under a raw id) and
    // strictly weaker than the new scheme, so it must be retired once no legacy session
    // can still be valid — i.e. once one full `SESSION_TTL_SECONDS` window has elapsed
    // since this code was deployed. See the audit doc's migration plan §5 for the exact
    // retirement steps. Feature-flagged via SESSION_LEGACY_ID_FALLBACK so retirement is a
    // config change, not a code change.
    if (this.legacyIdFallbackEnabled) {
      const legacy = await this.prisma.client.session.findUnique({ where: { id: rawToken } });
      if (legacy && legacy.tokenHash === null && !legacy.revoked && legacy.expiresAt >= new Date()) {
        return { userId: legacy.userId, sessionId: legacy.id };
      }
    }

    return null;
  }

  async revokeSession(sessionId: string) {
    const session = await this.prisma.client.session.update({
      where: { id: sessionId },
      data: { revoked: true },
    });
    if (session.tokenHash) {
      await this.safeDel(`session:${session.tokenHash}`, "session cache delete on revoke");
    }
  }

  async revokeAllSessionsForUser(userId: string) {
    const sessions = await this.prisma.client.session.findMany({
      where: { userId, revoked: false },
    });
    await this.prisma.client.session.updateMany({
      where: { userId },
      data: { revoked: true },
    });
    await Promise.all(
      sessions
        .filter((s) => s.tokenHash)
        .map((s) => this.safeDel(`session:${s.tokenHash}`, "session cache delete on revoke-all")),
    );
  }

  async listDeviceHistory(userId: string) {
    return this.prisma.client.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
}
