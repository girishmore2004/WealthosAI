import { ConfigService } from "@nestjs/config";
import { Logger } from "@nestjs/common";
import { MockEmailOtpAdapter } from "./mock-email-otp.adapter";
import { ResendEmailOtpAdapter } from "./resend-email-otp.adapter";
import { BrevoEmailOtpAdapter } from "./brevo-email-otp.adapter";
import { OtpDeliveryAdapter } from "./otp-delivery.adapter";

export const OTP_DELIVERY_ADAPTER = "OTP_DELIVERY_ADAPTER";

const logger = new Logger("OtpAdapterFactory");

// `OTP_ADAPTER` was previously read into configuration() but nothing ever branched on
// it — MockEmailOtpAdapter was hardcoded into AuthModule regardless of the env var's
// value. This factory is what actually wires it: OTP_ADAPTER=mock (default) keeps the
// zero-cost console-log adapter; OTP_ADAPTER=resend switches to a real send via Resend;
// OTP_ADAPTER=brevo switches to a real send via Brevo (no domain verification required
// — see brevo-email-otp.adapter.ts for why this exists alongside Resend).
export function otpAdapterFactory(
  config: ConfigService,
  mockAdapter: MockEmailOtpAdapter,
  resendAdapter: ResendEmailOtpAdapter,
  brevoAdapter: BrevoEmailOtpAdapter,
): OtpDeliveryAdapter {
  const selected = config.get<string>("otpAdapter");
  switch (selected) {
    case "resend":
      return resendAdapter;
    case "brevo":
      return brevoAdapter;
    case "mock":
    case undefined:
      return mockAdapter;
    default:
      logger.warn(`Unknown OTP_ADAPTER "${selected}" — falling back to the mock adapter.`);
      return mockAdapter;
  }
}
