import { Inject, Injectable, BadRequestException, HttpException, HttpStatus, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomInt } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";
import { AuditService } from "../audit/audit.service";
import { SessionService } from "./session.service";
import { OtpDeliveryAdapter } from "./adapters/otp-delivery.adapter";
import { OTP_DELIVERY_ADAPTER } from "./adapters/otp-adapter.factory";

const OTP_TTL_SECONDS = 10 * 60;
const OTP_RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const OTP_RATE_LIMIT_MAX_REQUESTS = 5;

// Normalizes once, consistently, everywhere. The previous implementation lowercased in
// three separate places but missed the `existingUser` lookup inside `requestOtp` (it
// compared against the raw, un-normalized `email` argument) — meaning a returning user
// who typed their email with different casing than their first signup was silently
// treated as brand new: `isNewUser` came back `true` and the freshly-created OtpCode row
// was never linked to their real `userId` via `data.userId`. Every read/write below goes
// through this single function so that class of bug can't reappear.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function hashCode(identifier: string, code: string) {
  return createHash("sha256").update(`${identifier}:${code}`).digest("hex");
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger("AuthService");

  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private audit: AuditService,
    private sessions: SessionService,
    private config: ConfigService,
    @Inject(OTP_DELIVERY_ADAPTER) private otpAdapter: OtpDeliveryAdapter,
  ) {}

  private get verifyMaxAttempts() {
    return this.config.get<number>("otp.verifyMaxAttempts") ?? 5;
  }
  private get verifyLockoutSeconds() {
    return this.config.get<number>("otp.verifyLockoutSeconds") ?? 900;
  }
  private get resendCooldownSeconds() {
    return this.config.get<number>("otp.resendCooldownSeconds") ?? 45;
  }
  private get requestIpMax() {
    return this.config.get<number>("otp.requestIpMax") ?? 15;
  }
  private get requestIpWindowSeconds() {
    return this.config.get<number>("otp.requestIpWindowSeconds") ?? 3600;
  }

  // --- Redis wrappers: fail OPEN on infra failure -------------------------------------
  // Rate limiting / lockout is a security control, but it sits in front of every login
  // attempt in the app. If Redis is unreachable, the original code (a bare `await
  // this.redis.incrWithExpiry(...)`) would throw and take down OTP request/verify
  // entirely for every user, cluster-wide, for the duration of the outage. Given the OTP
  // code itself is still short-lived (10 minutes) and email delivery already depends on
  // an external provider, briefly losing the *extra* brute-force throttle during a Redis
  // outage is judged an acceptable trade-off against a full login outage. Every skipped
  // check is logged so an outage is visible in logs/metrics, not silent.
  private async safeIncr(key: string, ttlSeconds: number, context: string): Promise<number | null> {
    try {
      return await this.redis.incrWithExpiry(key, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; failing open on this check. ${(err as Error).message}`);
      return null;
    }
  }

  private async safeGet(key: string, context: string): Promise<string | null> {
    try {
      return await this.redis.get(key);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; failing open on this check. ${(err as Error).message}`);
      return null;
    }
  }

  private async safeSet(key: string, value: string, ttlSeconds: number, context: string): Promise<void> {
    try {
      await this.redis.set(key, value, ttlSeconds);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; skipping. ${(err as Error).message}`);
    }
  }

  private async safeDel(key: string, context: string): Promise<void> {
    try {
      await this.redis.del(key);
    } catch (err) {
      this.logger.warn(`Redis unavailable during ${context}; skipping. ${(err as Error).message}`);
    }
  }

  async requestOtp(email: string, ipAddress?: string) {
    const identifier = normalizeEmail(email);

    // Minimum resend interval: the original implementation only capped total requests
    // per hour (5), which still allowed all 5 to be fired back-to-back instantly,
    // spamming the mailbox and leaving several simultaneously-valid codes outstanding at
    // once (a larger effective target surface for a verify-side brute force). A short
    // per-identifier cooldown closes that without changing the hourly cap's semantics.
    const cooldownKey = `otp-cooldown:${identifier}`;
    const onCooldown = await this.safeGet(cooldownKey, "otp resend cooldown check");
    if (onCooldown) {
      throw new HttpException("Please wait before requesting another code.", HttpStatus.TOO_MANY_REQUESTS);
    }

    // Per-identifier hourly cap — unchanged threshold/behavior from the original
    // implementation (5 requests / 60 minutes).
    const identifierKey = `otp-rate:${identifier}`;
    const identifierAttempts = await this.safeIncr(identifierKey, OTP_RATE_LIMIT_WINDOW_SECONDS, "otp identifier rate limit");
    if (identifierAttempts !== null && identifierAttempts > OTP_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException("Too many OTP requests. Please try again later.", HttpStatus.TOO_MANY_REQUESTS);
    }

    // Per-IP hourly cap — new. The identifier-only cap does nothing to stop one attacker
    // IP from spraying OTP requests across many *different* target emails, since each
    // individual email's own counter never crosses its own limit that way.
    if (ipAddress) {
      const ipKey = `otp-rate-ip:${ipAddress}`;
      const ipAttempts = await this.safeIncr(ipKey, this.requestIpWindowSeconds, "otp ip rate limit");
      if (ipAttempts !== null && ipAttempts > this.requestIpMax) {
        throw new HttpException(
          "Too many OTP requests from this network. Please try again later.",
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    const code = randomInt(100000, 999999).toString();
    const existingUser = await this.prisma.client.user.findUnique({ where: { email: identifier } });

    await this.prisma.client.otpCode.create({
      data: {
        identifier,
        userId: existingUser?.id,
        codeHash: hashCode(identifier, code),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      },
    });

    await this.otpAdapter.send(identifier, code);
    await this.safeSet(cooldownKey, "1", this.resendCooldownSeconds, "otp resend cooldown set");
    await this.audit.log("otp_requested", existingUser?.id, { email: identifier });

    return { message: "OTP sent", isNewUser: !existingUser };
  }

  async verifyOtp(email: string, code: string, userAgent?: string, ipAddress?: string) {
    const identifier = normalizeEmail(email);

    // Lockout check happens BEFORE touching OtpCode at all. A locked-out identifier gets
    // the same 429 regardless of whether the submitted code would otherwise have
    // matched — the response *status code* does reveal "you're currently locked out" as
    // distinct from "wrong code" (a deliberate, documented trade-off: hiding lockout
    // state entirely would also stop legitimate users from understanding why their
    // correct code stopped being accepted).
    const lockoutKey = `otp-lockout:${identifier}`;
    const isLockedOut = await this.safeGet(lockoutKey, "otp lockout check");
    if (isLockedOut) {
      await this.audit.log("otp_verify_locked_out", undefined, { email: identifier, phase: "blocked" });
      throw new HttpException(
        "Too many incorrect attempts. Please request a new code and try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const codeHash = hashCode(identifier, code);
    const otp = await this.prisma.client.otpCode.findFirst({
      where: { identifier, codeHash, consumed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    if (!otp) {
      await this.registerFailedAttempt(identifier, lockoutKey);
      throw new BadRequestException("Invalid or expired code");
    }

    await this.prisma.client.otpCode.update({
      where: { id: otp.id },
      data: { consumed: true },
    });
    await this.safeDel(`otp-fail:${identifier}`, "otp fail counter reset");

    const user = await this.getOrCreateUser(identifier);

    const { session, rawToken } = await this.sessions.createSession(user.id, userAgent, ipAddress);
    await this.audit.log("login_success", user.id, { via: "otp" });

    return { user, session, rawToken };
  }

  async logout(sessionId: string, userId: string) {
    await this.sessions.revokeSession(sessionId);
    await this.audit.log("logout", userId);
  }

  async logoutAllDevices(userId: string) {
    await this.sessions.revokeAllSessionsForUser(userId);
    await this.audit.log("logout_all_devices", userId);
  }

  private async getOrCreateUser(identifier: string) {
    const existing = await this.prisma.client.user.findUnique({ where: { email: identifier } });
    if (existing) return existing;

    const created = await this.prisma.client.user.create({ data: { email: identifier } });
    await this.audit.log("user_registered", created.id, { email: identifier });
    return created;
  }

  // Redis-backed fast path (primary enforcement — this is what actually blocks the next
  // request) plus a best-effort Postgres `attempts` increment on the most recent
  // outstanding OTP row for this identifier, if one exists. The Postgres counter is a
  // durable/audit signal that survives a Redis flush or restart; it is NOT relied on for
  // the lockout decision itself (the Redis counter is authoritative for that), because it
  // only has something to attach to while a code is still outstanding, whereas the Redis
  // counter tracks failed attempts against the *identifier* regardless of whether any
  // code is currently live.
  private async registerFailedAttempt(identifier: string, lockoutKey: string) {
    const failKey = `otp-fail:${identifier}`;
    const fails = await this.safeIncr(failKey, this.verifyLockoutSeconds, "otp fail counter increment");
    await this.audit.log("otp_verify_failed", undefined, { email: identifier, attempt: fails ?? "unknown (redis unavailable)" });

    if (fails !== null && fails >= this.verifyMaxAttempts) {
      await this.safeSet(lockoutKey, "1", this.verifyLockoutSeconds, "otp lockout set");
      await this.audit.log("otp_verify_locked_out", undefined, { email: identifier, phase: "triggered" });
    }

    const latestOtp = await this.prisma.client.otpCode.findFirst({
      where: { identifier, consumed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });
    if (latestOtp) {
      await this.prisma.client.otpCode.update({
        where: { id: latestOtp.id },
        data: { attempts: { increment: 1 } },
      });
    }
  }
}
