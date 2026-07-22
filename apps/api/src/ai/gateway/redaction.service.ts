import { Injectable } from "@nestjs/common";

export interface RedactionResult {
  text: string;
  /** Which rules fired, for logging transparency — e.g. ["email", "phone"]. Never
   * includes the matched value itself, only the rule name. */
  redactedTypes: string[];
}

interface RedactionRule {
  type: string;
  pattern: RegExp;
  replacement: string;
}

// Regex-based, best-effort PII redaction — NOT a substitute for a real PII-detection
// model or a legal/compliance review. This exists to reduce the chance of a user
// pasting an email, phone number, PAN, or account-number-shaped string directly into a
// free-text field (e.g. a Coach question or a document's OCR text) before that text
// leaves the process boundary to a third-party model host. It intentionally does NOT
// touch names, addresses, or amounts — those are frequently exactly the context a
// grounded answer needs, and a regex has no way to tell "the user's own data, sent on
// their own behalf" apart from "someone else's PII", so scrubbing free-form prose
// further than this would make answers worse without a corresponding safety gain.
//
// Callers decide what counts as "free text" (user-authored prose) vs. "trusted
// structured context" (numbers the caller itself assembled from the DB for grounding)
// — only the former should ever be passed through redact(). See AiGatewayService.
const RULES: RedactionRule[] = [
  { type: "email", pattern: /[\w.+-]+@[\w-]+\.[\w.-]+/g, replacement: "[redacted-email]" },
  { type: "phone", pattern: /(?:\+?91[-\s]?)?\b[6-9]\d{9}\b/g, replacement: "[redacted-phone]" },
  { type: "pan", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replacement: "[redacted-pan]" },
  { type: "aadhaar", pattern: /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, replacement: "[redacted-aadhaar]" },
  { type: "card", pattern: /\b(?:\d[ -]?){13,16}\b/g, replacement: "[redacted-card]" },
];

@Injectable()
export class RedactionService {
  redact(text: string): RedactionResult {
    let result = text;
    const redactedTypes: string[] = [];

    for (const rule of RULES) {
      if (rule.pattern.test(result)) {
        redactedTypes.push(rule.type);
      }
      // reset lastIndex — the rules use the global flag and .test() above advances it
      rule.pattern.lastIndex = 0;
      result = result.replace(rule.pattern, rule.replacement);
    }

    return { text: result, redactedTypes };
  }
}
