import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OtpDeliveryAdapter } from "./otp-delivery.adapter";

// Sends the OTP over Brevo's Transactional Email API
// (https://developers.brevo.com/reference/sendtransacemail) — a plain fetch call,
// matching the pattern used by ResendEmailOtpAdapter and groq.client.ts elsewhere in
// this repo, so there's one fewer dependency to install/pin.
//
// Why this adapter exists alongside Resend: Resend's sandbox sender
// (onboarding@resend.dev) only delivers to the email address the Resend account itself
// was signed up with — every other recipient silently fails — until you verify a
// domain. Brevo's free plan instead requires only a *verified sender email address*
// (a one-time confirmation-link click, no DNS records), and its free tier (300
// emails/day, no credit card) sends to arbitrary recipients from day one. It also
// talks HTTPS, not SMTP, so it isn't affected by Render free-tier services blocking
// outbound SMTP ports 25/465/587.
//
// Selected via OTP_ADAPTER=brevo + BREVO_API_KEY — see otp-adapter.factory.ts.
@Injectable()
export class BrevoEmailOtpAdapter implements OtpDeliveryAdapter {
  private readonly logger = new Logger("BrevoOtpDelivery");

  constructor(private config: ConfigService) {}

  async send(identifier: string, code: string): Promise<void> {
    const apiKey = this.config.get<string>("brevo.apiKey");
    if (!apiKey) {
      throw new Error("BREVO_API_KEY is not set but OTP_ADAPTER=brevo — cannot send OTP email.");
    }

    const senderEmail = this.config.get<string>("brevo.senderEmail");
    const senderName = this.config.get<string>("brevo.senderName");

    const response = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        sender: { name: senderName, email: senderEmail },
        to: [{ email: identifier }],
        subject: "Your WealthOS AI login code",
        textContent: `Your login code is ${code}. It expires in 10 minutes. If you didn't request this, you can ignore this email.`,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      this.logger.error(`Brevo send failed (${response.status}): ${body}`);
      throw new Error("Failed to send OTP email via Brevo.");
    }
  }
}
