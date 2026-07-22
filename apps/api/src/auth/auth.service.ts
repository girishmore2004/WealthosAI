import { Inject, Injectable, BadRequestException, HttpException, HttpStatus } from "@nestjs/common";
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

function hashCode(email: string, code: string) {
  return createHash("sha256").update(`${email.toLowerCase()}:${code}`).digest("hex");
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private audit: AuditService,
    private sessions: SessionService,
    @Inject(OTP_DELIVERY_ADAPTER) private otpAdapter: OtpDeliveryAdapter,
  ) {}

  async requestOtp(email: string) {
    const rateLimitKey = `otp-rate:${email.toLowerCase()}`;
    const attempts = await this.redis.incrWithExpiry(rateLimitKey, OTP_RATE_LIMIT_WINDOW_SECONDS);
    if (attempts > OTP_RATE_LIMIT_MAX_REQUESTS) {
      throw new HttpException(
        "Too many OTP requests. Please try again later.",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const code = randomInt(100000, 999999).toString();
    const existingUser = await this.prisma.client.user.findUnique({ where: { email } });

    await this.prisma.client.otpCode.create({
      data: {
        identifier: email.toLowerCase(),
        userId: existingUser?.id,
        codeHash: hashCode(email, code),
        expiresAt: new Date(Date.now() + OTP_TTL_SECONDS * 1000),
      },
    });

    await this.otpAdapter.send(email, code);
    await this.audit.log("otp_requested", existingUser?.id, { email });

    return { message: "OTP sent", isNewUser: !existingUser };
  }

  async verifyOtp(email: string, code: string, userAgent?: string, ipAddress?: string) {
    const identifier = email.toLowerCase();
    const codeHash = hashCode(email, code);

    const otp = await this.prisma.client.otpCode.findFirst({
      where: { identifier, codeHash, consumed: false, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: "desc" },
    });

    if (!otp) {
      throw new BadRequestException("Invalid or expired code");
    }

    await this.prisma.client.otpCode.update({
      where: { id: otp.id },
      data: { consumed: true },
    });

    let user = await this.prisma.client.user.findUnique({ where: { email: identifier } });
    if (!user) {
      user = await this.prisma.client.user.create({
        data: { email: identifier },
      });
      await this.audit.log("user_registered", user.id, { email: identifier });
    }

    const session = await this.sessions.createSession(user.id, userAgent, ipAddress);
    await this.audit.log("login_success", user.id, { via: "otp" });

    return { user, session };
  }

  async logout(sessionId: string, userId: string) {
    await this.sessions.revokeSession(sessionId);
    await this.audit.log("logout", userId);
  }

  async logoutAllDevices(userId: string) {
    await this.sessions.revokeAllSessionsForUser(userId);
    await this.audit.log("logout_all_devices", userId);
  }
}
