// Abstracts how a one-time login code actually reaches the user. Auth flow only ever
// calls `send(identifier, code)` — swapping providers (mock console log, Resend,
// SendGrid, MSG91, ...) never touches AuthService. See otp-adapter.factory.ts for how
// the concrete implementation is chosen based on the OTP_ADAPTER env var.
export interface OtpDeliveryAdapter {
  send(identifier: string, code: string): Promise<void>;
}
