import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { MockEmailOtpAdapter } from "./adapters/mock-email-otp.adapter";
import { ResendEmailOtpAdapter } from "./adapters/resend-email-otp.adapter";
import { OTP_DELIVERY_ADAPTER, otpAdapterFactory } from "./adapters/otp-adapter.factory";

// Global so that SessionService is resolvable by SessionAuthGuard from any module
// that applies @UseGuards(SessionAuthGuard), without every one of those 20+ feature
// modules needing to explicitly import AuthModule. Mirrors PrismaModule, which is
// @Global() for the same reason (PrismaService is a guard/provider dependency used
// app-wide). See the DI note in common/guards/session-auth.guard.ts.
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    SessionService,
    MockEmailOtpAdapter,
    ResendEmailOtpAdapter,
    {
      provide: OTP_DELIVERY_ADAPTER,
      useFactory: otpAdapterFactory,
      inject: [ConfigService, MockEmailOtpAdapter, ResendEmailOtpAdapter],
    },
  ],
  exports: [SessionService],
})
export class AuthModule {}
