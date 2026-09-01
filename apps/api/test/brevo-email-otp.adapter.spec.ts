import { BrevoEmailOtpAdapter } from "../src/auth/adapters/brevo-email-otp.adapter";

describe("BrevoEmailOtpAdapter", () => {
  const mockConfig = { get: jest.fn() };
  let adapter: BrevoEmailOtpAdapter;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    adapter = new BrevoEmailOtpAdapter(mockConfig as any);
  });

  function configWith(apiKey: string | undefined, senderEmail?: string, senderName?: string) {
    mockConfig.get.mockImplementation((key: string) => {
      if (key === "brevo.apiKey") return apiKey;
      if (key === "brevo.senderEmail") return senderEmail ?? "you@example.com";
      if (key === "brevo.senderName") return senderName ?? "WealthOS AI";
      return undefined;
    });
  }

  it("throws without calling the network when BREVO_API_KEY is unset", async () => {
    configWith(undefined);
    await expect(adapter.send("user@example.com", "123456")).rejects.toThrow(/BREVO_API_KEY is not set/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs to Brevo's transactional email endpoint with the code embedded in the body", async () => {
    configWith("xkeysib-test", "login@you.example.com", "WealthOS AI");
    fetchMock.mockResolvedValue({ ok: true });

    await adapter.send("user@example.com", "654321");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers["api-key"]).toBe("xkeysib-test");

    const body = JSON.parse(init.body);
    expect(body.to).toEqual([{ email: "user@example.com" }]);
    expect(body.sender).toEqual({ name: "WealthOS AI", email: "login@you.example.com" });
    expect(body.textContent).toContain("654321");
  });

  it("throws when Brevo responds with a non-ok status", async () => {
    configWith("xkeysib-test");
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => "sender not verified" });

    await expect(adapter.send("user@example.com", "111111")).rejects.toThrow(/Failed to send OTP email/);
  });

  it("propagates a network-level failure (e.g. fetch rejecting) rather than swallowing it", async () => {
    configWith("xkeysib-test");
    fetchMock.mockRejectedValue(new Error("network unreachable"));

    await expect(adapter.send("user@example.com", "222222")).rejects.toThrow("network unreachable");
  });
});
