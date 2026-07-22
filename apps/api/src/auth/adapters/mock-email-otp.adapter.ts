import { Injectable, Logger } from "@nestjs/common";
import { OtpDeliveryAdapter } from "./otp-delivery.adapter";

export type { OtpDeliveryAdapter };

// Mock adapter: instead of paying for a transactional email/SMS provider (SendGrid,
// Twilio, MSG91, etc.), the OTP is logged to the API console. This keeps the MVP fully
// runnable at zero cost. Selected when OTP_ADAPTER=mock (the default) — see
// otp-adapter.factory.ts. Swap to a real provider by setting OTP_ADAPTER=resend.
@Injectable()
export class MockEmailOtpAdapter implements OtpDeliveryAdapter {
  private readonly logger = new Logger("MockOtpDelivery");

  async send(identifier: string, code: string): Promise<void> {
    this.logger.log(`[DEV ONLY] OTP for ${identifier}: ${code} (valid 10 minutes)`);
  }
}
