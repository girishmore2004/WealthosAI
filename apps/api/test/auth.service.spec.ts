import { Test } from "@nestjs/testing";
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
  const mockRedis = { incrWithExpiry: jest.fn() };
  const mockAudit = { log: jest.fn() };
  const mockSessions = { createSession: jest.fn() };
  const mockOtpAdapter = { send: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: RedisService, useValue: mockRedis },
        { provide: AuditService, useValue: mockAudit },
        { provide: SessionService, useValue: mockSessions },
        { provide: OTP_DELIVERY_ADAPTER, useValue: mockOtpAdapter },
      ],
    }).compile();
    service = moduleRef.get(AuthService);
  });

  describe("requestOtp", () => {
    it("sends an OTP and reports whether the user is new", async () => {
      mockRedis.incrWithExpiry.mockResolvedValue(1);
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

    it("never stores the raw OTP code — only a hash", async () => {
      mockRedis.incrWithExpiry.mockResolvedValue(1);
      mockPrisma.client.user.findUnique.mockResolvedValue(null);
      mockPrisma.client.otpCode.create.mockResolvedValue({});

      await service.requestOtp("check@example.com");

      const createCall = mockPrisma.client.otpCode.create.mock.calls[0][0];
      expect(createCall.data.codeHash).toBeDefined();
      expect(createCall.data).not.toHaveProperty("code");
      expect(createCall.data.codeHash).toHaveLength(64); // sha256 hex digest length
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
      mockSessions.createSession.mockResolvedValue({ id: "session-1" });

      const { user } = await service.verifyOtp("user@example.com", "123456");

      expect(mockPrisma.client.user.create).toHaveBeenCalled();
      expect(user.id).toBe("user-new");
    });

    it("marks the OTP as consumed so it can't be reused", async () => {
      mockPrisma.client.otpCode.findFirst.mockResolvedValue({ id: "otp1" });
      mockPrisma.client.otpCode.update.mockResolvedValue({});
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", email: "user@example.com" });
      mockSessions.createSession.mockResolvedValue({ id: "session-1" });

      await service.verifyOtp("user@example.com", "123456");

      expect(mockPrisma.client.otpCode.update).toHaveBeenCalledWith({
        where: { id: "otp1" },
        data: { consumed: true },
      });
    });
  });
});
