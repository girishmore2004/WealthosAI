import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AuthService } from "../src/auth/auth.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { RedisService } from "../src/redis/redis.service";
import { AuditService } from "../src/audit/audit.service";
import { SessionService } from "../src/auth/session.service";
import { OTP_DELIVERY_ADAPTER } from "../src/auth/adapters/otp-adapter.factory";

describe("AuthService", () => {
  let service: AuthService;

  const mockPrisma = {
    client: {
      user: { findUnique: jest.fn(), create: jest.fn() },
      otpCode: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    },
  };
  // get/set/del were added for the brute-force lockout + resend-cooldown logic in
  // AuthService (see safeGet/safeSet/safeDel/registerFailedAttempt); incrWithExpiry
  // already existed for the original per-identifier rate limit.
  const mockRedis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
    incrWithExpiry: jest.fn(),
  };
  const mockAudit = { log: jest.fn() };
  const mockSessions = { createSession: jest.fn() };
  const mockOtpAdapter = { send: jest.fn() };
  // AuthService now reads otp.verifyMaxAttempts / otp.verifyLockoutSeconds /
  // otp.resendCooldownSeconds / otp.requestIpMax / otp.requestIpWindowSeconds via
  // ConfigService. Returning undefined for every key exercises the service's built-in
  // defaults (5 attempts / 900s lockout / 45s cooldown / 15 per hour per IP / 3600s
  // window) — the same values the tests below assert against — without duplicating
  // those constants a second time in this file.
  const mockConfig = { get: jest.fn() };

  beforeEach(async () => {
    jest.resetAllMocks();

    // Sane, non-triggering defaults so tests that aren't specifically exercising rate
    // limiting / lockout / cooldown don't each have to restate them.
    mockRedis.get.mockResolvedValue(null); // not on cooldown, not locked out
    mockRedis.set.mockResolvedValue(undefined);
    mockRedis.del.mockResolvedValue(undefined);
    mockRedis.incrWithExpiry.mockResolvedValue(1); // well under any configured limit
    mockConfig.get.mockReturnValue(undefined); // -> AuthService falls back to defaults

    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AuditService, useValue: mockAudit },
        { provide: SessionService, useValue: mockSessions },
        { provide: ConfigService, useValue: mockConfig },
        { provide: OTP_DELIVERY_ADAPTER, useValue: mockOtpAdapter },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe("requestOtp", () => {
    it("sends an OTP and reports whether the user is new", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(null);
      mockPrisma.client.otpCode.create.mockResolvedValue({});

      const result = await service.requestOtp("new@example.com");

      expect(result.isNewUser).toBe(true);
      expect(mockOtpAdapter.send).toHaveBeenCalledWith("new@example.com", expect.stringMatching(/^\d{6}$/));
    });

    it("rejects with a 429-style error once the rate limit is exceeded", async () => {
      mockRedis.incrWithExpiry.mockResolvedValue(6); // over the 5-request limit

      await expect(service.requestOtp("spammer@example.com")).rejects.toThrow(/too many/i);
      expect(mockOtpAdapter.send).not.toHaveBeenCalled();
    });

    it("rejects with a 429-style error when the per-identifier resend cooldown hasn't elapsed", async () => {
      mockRedis.get.mockResolvedValue("1"); // cooldown key present

      await expect(service.requestOtp("toofast@example.com")).rejects.toThrow(/wait before requesting/i);
      expect(mockOtpAdapter.send).not.toHaveBeenCalled();
    });

    it("never stores the raw OTP code — only a hash", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(null);
      mockPrisma.client.otpCode.create.mockResolvedValue({});

      await service.requestOtp("check@example.com");

      const createCall = mockPrisma.client.otpCode.create.mock.calls[0][0];
      expect(createCall.data.codeHash).toBeDefined();
      expect(createCall.data).not.toHaveProperty("code");
      expect(createCall.data.codeHash).toHaveLength(64); // sha256 hex digest length
    });

    it("normalizes email casing so a returning user isn't misclassified as new", async () => {
      // Regression test for the bug where requestOtp's existingUser lookup compared
      // against the raw, un-normalized email instead of the lowercased identifier used
      // everywhere else — a returning user typing different casing than their original
      // signup was silently treated as brand new.
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "existing-user", email: "person@example.com" });
      mockPrisma.client.otpCode.create.mockResolvedValue({});

      const result = await service.requestOtp("Person@Example.com");

      expect(mockPrisma.client.user.findUnique).toHaveBeenCalledWith({ where: { email: "person@example.com" } });
      expect(result.isNewUser).toBe(false);
      expect(mockPrisma.client.otpCode.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ identifier: "person@example.com", userId: "existing-user" }),
        }),
      );
    });
  });

  describe("verifyOtp", () => {
    it("rejects an invalid or expired code without revealing which", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue(null);

      await expect(service.verifyOtp("user@example.com", "000000")).rejects.toThrow(/invalid or expired/i);
    });

    it("creates a new user on first successful verification, existing user otherwise", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue({ id: "otp1" });
      mockPrisma.client.otpCode.update.mockResolvedValue({});
      mockPrisma.client.user.findUnique.mockResolvedValue(null);
      mockPrisma.client.user.create.mockResolvedValue({ id: "user-new", email: "user@example.com" });
      // SessionService.createSession now returns { session, rawToken } (an opaque bearer
      // token separate from the session row) rather than the session row alone.
      mockSessions.createSession.mockResolvedValue({
        session: { id: "session-1" },
        rawToken: "test-raw-token",
      });

      const { user } = await service.verifyOtp("user@example.com", "123456");

      expect(mockPrisma.client.user.create).toHaveBeenCalled();
      expect(user.id).toBe("user-new");
    });

    it("marks the OTP as consumed so it can't be reused", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue({ id: "otp1" });
      mockPrisma.client.otpCode.update.mockResolvedValue({});
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.com" });
      mockSessions.createSession.mockResolvedValue({
        session: { id: "session-1" },
        rawToken: "test-raw-token",
      });

      await service.verifyOtp("user@example.com", "123456");

      expect(mockPrisma.client.otpCode.update).toHaveBeenCalledWith({
        where: { id: "otp1" },
        data: { consumed: true },
      });
    });

    it("returns the opaque bearer token alongside the session, never the session id alone", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue({ id: "otp1" });
      mockPrisma.client.otpCode.update.mockResolvedValue({});
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.com" });
      mockSessions.createSession.mockResolvedValue({
        session: { id: "session-1" },
        rawToken: "test-raw-token",
      });

      const result = await service.verifyOtp("user@example.com", "123456");

      expect(result.rawToken).toBe("test-raw-token");
      expect(result.session).toEqual({ id: "session-1" });
    });

    it("locks out the identifier after reaching the max failed-attempt threshold", async () => {
      mockRedis.incrWithExpiry.mockResolvedValue(5); // 5th failed attempt (default max)
      mockPrisma.client.otpCode.findFirst.mockResolvedValue(null); // wrong code

      await expect(service.verifyOtp("locked@example.com", "000000")).rejects.toThrow(/invalid or expired/i);

      expect(mockRedis.set).toHaveBeenCalledWith("otp-lockout:locked@example.com", "1", 900);
    });

    it("short-circuits with 429 when already locked out, without querying the database", async () => {
      mockRedis.get.mockResolvedValue("1"); // lockout key present

      await expect(service.verifyOtp("locked@example.com", "000000")).rejects.toThrow(
        /too many incorrect attempts/i,
      );
      expect(mockPrisma.client.otpCode.findFirst).not.toHaveBeenCalled();
    });

    it("resets the failed-attempt counter on a successful verification", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue({ id: "otp1" });
      mockPrisma.client.otpCode.update.mockResolvedValue({});
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.com" });
      mockSessions.createSession.mockResolvedValue({
        session: { id: "session-1" },
        rawToken: "test-raw-token",
      });

      await service.verifyOtp("user@example.com", "123456");

      expect(mockRedis.del).toHaveBeenCalledWith("otp-fail:user@example.com");
    });
  });
});
