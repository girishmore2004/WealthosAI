import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OtpDeliveryAdapter } from "./otp-delivery.adapter";

// Sends the OTP over Resend's HTTP API (https://resend.com/docs/api-reference/emails/send-email)
// — a plain fetch call rather than the Resend SDK, matching the pattern used elsewhere
// in this repo (see groq.client.ts) so there's one fewer dependency to install/pin.
// Selected via OTP_ADAPTER=resend + RESEND_API_KEY — see otp-adapter.factory.ts.
//
// NOTE: like the Groq client, this has not been exercised against a live Resend
// endpoint in this build environment (network egress here can't reach api.resend.com).
// It's written to Resend's documented contract; treat the first real send with a live
// RESEND_API_KEY as the actual integration test.
@Injectable()
export class ResendEmailOtpAdapter implements OtpDeliveryAdapter {
  private readonly logger = new Logger("ResendOtpDelivery");

  constructor(private config: ConfigService) {}

  async send(identifier: string, code: string): Promise<void> {
    const apiKey = this.config.get<string>("resend.apiKey");
    if (!apiKey) {
      // Fail loudly rather than silently pretending the email went out — a missing key
      // here means every login attempt would otherwise hang waiting on an OTP that
      // never arrives, with no signal as to why.
      throw new Error("RESEND_API_KEY is not set but OTP_ADAPTER=resend — cannot send OTP email.");
    }

    const from = this.config.get<string>("resend.fromEmail");
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: identifier,
        subject: "Your WealthOS AI login code",
        text: `Your login code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.logger.error(`Resend send failed (${response.status}): ${body}`);
      throw new Error("Failed to send OTP email via Resend.");
    }
  }
}
