import { CookieOptions } from "express";
import { ConfigService } from "@nestjs/config";

// Backend (Render) and frontend (Vercel) live on two different eTLD+1 domains in the
// default deployment, so this is a cross-site request from the browser's point of view.
// Cross-site cookies require `SameSite=None; Secure` — `SameSite=Lax` (the safe default
// for same-site apps) is silently dropped by the browser on cross-site fetch/XHR calls,
// which is what makes login look like it "sometimes doesn't stick" in production.
//
// `secure: true` is fine even in the cross-site case because Render/Vercel are both
// HTTPS-only in practice; it's only local dev (http://localhost) that needs `Lax` +
// non-secure, since `None` cookies are rejected outright over plain http.
//
// IMPORTANT: whatever options this returns MUST be passed to *both* res.cookie() (set)
// and res.clearCookie() (logout) — Express matches cookies to clear by name + these
// attributes, so passing different options to clearCookie is a common way logout fails
// silently while looking like it succeeded.
export function getSessionCookieOptions(config: ConfigService, maxAgeMs?: number): CookieOptions {
  const crossSite = config.get<boolean>("crossSiteCookies");
  const options: CookieOptions = {
    httpOnly: true,
    secure: crossSite || process.env.NODE_ENV === "production",
    sameSite: crossSite ? "none" : "lax",
    path: "/",
  };
  if (maxAgeMs !== undefined) {
    options.maxAge = maxAgeMs;
  }
  return options;
}
