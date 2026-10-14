import { Injectable, Logger } from "@nestjs/common";
import { OtpDeliveryAdapter } from "./otp-delivery.adapter";

export type { OtpDeliveryAdapter };

// Mock adapter (OTP_ADAPTER=mock): does NOT deliver anything. The code is intentionally
// never logged — anything written to the API console ends up in the Render logs, where
// it would expose live login codes. Use OTP_ADAPTER=brevo or OTP_ADAPTER=resend so real
// (non-demo) users actually receive their code by email. See otp-adapter.factory.ts.
@Injectable()
export class MockEmailOtpAdapter implements OtpDeliveryAdapter {
  private readonly logger = new Logger("MockOtpDelivery");

  async send(identifier: string, _code: string): Promise<void> {
    this.logger.warn(
      `OTP_ADAPTER=mock: a code was generated for ${identifier} but NOT delivered (and is never logged). Set OTP_ADAPTER=brevo or resend to email codes.`,
    );
  }
}
