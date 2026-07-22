import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AuthController } from "./auth.controller";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { MockEmailOtpAdapter } from "./adapters/mock-email-otp.adapter";
import { ResendEmailOtpAdapter } from "./adapters/resend-email-otp.adapter";
import { OTP_DELIVERY_ADAPTER, otpAdapterFactory } from "./adapters/otp-adapter.factory";

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
