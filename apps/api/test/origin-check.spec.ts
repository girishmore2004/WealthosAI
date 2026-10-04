import { NextFunction, Request, Response } from "express";

// The session lives in a cookie, and in a cross-site deployment that cookie is
// SameSite=None, so the browser attaches it to requests triggered by ANY site. CORS does not
// stop that: a hostile page can still fire a "simple" cross-site POST (e.g. a form) and the
// server would act on it. CORS only controls who may READ the response.
//
// This middleware closes that gap (CSRF) for state-changing methods by requiring the request
// to originate from a trusted origin:
//   1. Origin header present        -> must be trusted
//   2. else Referer present         -> its origin must be trusted
//   3. neither present              -> allowed only when the browser does not say the request is
//      cross-site (Sec-Fetch-Site). Non-browser clients can't be driven by a victim's cookies.
// Requests carrying no session cookie are not CSRF-able and pass straight through.

export type OriginMatcher = (origin: string) => boolean;

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginMatcherConfig {
  allowedOrigins: string[];
  vercelPreviewPrefix?: string;
}

/** Single definition of "trusted origin", shared by CORS and the CSRF check. */
export function buildOriginMatcher(config: OriginMatcherConfig): OriginMatcher {
  const exact = new Set(config.allowedOrigins.filter(Boolean).map((o) => o.replace(/\/$/, "")));
  return (origin: string): boolean => {
    const o = origin.replace(/\/$/, "");
    if (exact.has(o)) return true;
    const prefix = config.vercelPreviewPrefix;
    if (prefix && /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(o)) {
      try {
        return new URL(o).hostname.startsWith(prefix);
      } catch {
        return false;
      }
    }
    return false;
  };
}

function originOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null; // includes the literal string "null" sent by sandboxed/opaque origins
  }
}

export function csrfOriginCheck(isTrusted: OriginMatcher, cookieName: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!UNSAFE_METHODS.has(req.method) || !req.cookies?.[cookieName]) return next();

    const header = req.headers.origin;
    const fromOrigin = typeof header === "string" ? originOf(header) : null;
    const referer = req.headers.referer;
    const fromReferer = typeof referer === "string" ? originOf(referer) : null;

    if (typeof header === "string") {
      // An Origin header was sent: it is authoritative. An unparseable one ("null") is rejected.
      if (fromOrigin && isTrusted(fromOrigin)) return next();
    } else if (fromReferer) {
      if (isTrusted(fromReferer)) return next();
    } else {
      const site = req.headers["sec-fetch-site"];
      if (site !== "cross-site" && site !== "same-site") return next();
    }

    res.status(403).json({ statusCode: 403, message: "Request origin not allowed", error: "Forbidden" });
  };
}

describe("origin-check helpers", () => {
  it("builds a trusted-origin matcher", () => {
    const matcher = buildOriginMatcher({
      allowedOrigins: ["https://example.com"],
    });

    expect(matcher("https://example.com")).toBe(true);
    expect(matcher("https://evil.example.com")).toBe(false);
  });
});
