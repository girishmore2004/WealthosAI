import { getSessionCookieOptions } from "../src/auth/session-cookie.util";

function configWith(crossSite: boolean) {
  return { get: jest.fn().mockReturnValue(crossSite) } as any;
}

describe("getSessionCookieOptions", () => {
  it("uses SameSite=None + Secure when cross-site cookies are enabled", () => {
    const options = getSessionCookieOptions(configWith(true));
    expect(options.sameSite).toBe("none");
    expect(options.secure).toBe(true);
  });

  it("uses SameSite=Lax when cross-site cookies are disabled", () => {
    const options = getSessionCookieOptions(configWith(false));
    expect(options.sameSite).toBe("lax");
  });

  it("always sets httpOnly and a root path", () => {
    const options = getSessionCookieOptions(configWith(false));
    expect(options.httpOnly).toBe(true);
    expect(options.path).toBe("/");
  });

  it("includes maxAge only when explicitly provided, so clearCookie calls can omit it", () => {
    const withMaxAge = getSessionCookieOptions(configWith(true), 60000);
    expect(withMaxAge.maxAge).toBe(60000);

    const withoutMaxAge = getSessionCookieOptions(configWith(true));
    expect(withoutMaxAge.maxAge).toBeUndefined();
  });
});
