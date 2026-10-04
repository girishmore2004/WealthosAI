import { NextFunction, Request, Response } from "express";

// Baseline hardening headers for an API that returns only JSON / file downloads. Written
// by hand (rather than adding a dependency) because the set below is small and fixed.
//
//  - Cache-Control: no-store      financial data must never be kept by a shared cache/proxy
//  - X-Content-Type-Options       stops browsers MIME-sniffing a download into something executable
//  - X-Frame-Options / CSP        the API is never meant to be framed or to load subresources
//  - Referrer-Policy: no-referrer ids in URLs are not leaked to other sites
//  - Strict-Transport-Security    production only, so local HTTP development keeps working
export function securityHeaders(isProduction: boolean) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-site");
    if (isProduction) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
