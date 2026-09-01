import { otpAdapterFactory } from "../src/auth/adapters/otp-adapter.factory";
import { MockEmailOtpAdapter } from "../src/auth/adapters/mock-email-otp.adapter";
import { ResendEmailOtpAdapter } from "../src/auth/adapters/resend-email-otp.adapter";
import { BrevoEmailOtpAdapter } from "../src/auth/adapters/brevo-email-otp.adapter";

describe("otpAdapterFactory", () => {
  const mockAdapter = {} as MockEmailOtpAdapter;
  const resendAdapter = {} as ResendEmailOtpAdapter;
  const brevoAdapter = {} as BrevoEmailOtpAdapter;

  function configWith(value: string | undefined) {
    return { get: jest.fn().mockReturnValue(value) } as any;
  }

  it("selects the mock adapter when OTP_ADAPTER=mock", () => {
    const result = otpAdapterFactory(configWith("mock"), mockAdapter, resendAdapter, brevoAdapter);
    expect(result).toBe(mockAdapter);
  });

  it("selects the mock adapter by default when OTP_ADAPTER is unset", () => {
    const result = otpAdapterFactory(configWith(undefined), mockAdapter, resendAdapter, brevoAdapter);
    expect(result).toBe(mockAdapter);
  });

  it("selects the Resend adapter when OTP_ADAPTER=resend", () => {
    const result = otpAdapterFactory(configWith("resend"), mockAdapter, resendAdapter, brevoAdapter);
    expect(result).toBe(resendAdapter);
  });

  it("selects the Brevo adapter when OTP_ADAPTER=brevo", () => {
    const result = otpAdapterFactory(configWith("brevo"), mockAdapter, resendAdapter, brevoAdapter);
    expect(result).toBe(brevoAdapter);
  });

  it("falls back to the mock adapter for an unrecognized value rather than throwing", () => {
    const result = otpAdapterFactory(configWith("twilio"), mockAdapter, resendAdapter, brevoAdapter);
    expect(result).toBe(mockAdapter);
  });
});
