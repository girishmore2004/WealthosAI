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
  // Added in the security pass — these identify an account or a person but were previously
  // sent to the model verbatim:
  { type: "ifsc", pattern: /\b[A-Z]{4}0[A-Z0-9]{6}\b/g, replacement: "[redacted-ifsc]" },
  { type: "gstin", pattern: /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/g, replacement: "[redacted-gstin]" },
  // UPI handles (name@bank). Runs after the email rule, so real emails are already gone.
  { type: "upi", pattern: /\b[\w.-]{2,}@[a-z]{2,}\b/gi, replacement: "[redacted-upi]" },
  // A labelled identifier: "policy no: ABC12345", "a/c 123456789012", "folio number 1234567/89".
  // Only the identifier is replaced; the label stays so the sentence still reads.
  {
    type: "labelled-id",
    pattern: /\b((?:policy|account|a\/c|acct|folio|loan|customer|membership|uan|pran)\s*(?:no\.?|number|num|#|id)?\s*[:\-]?\s*)([A-Z0-9][A-Z0-9\/-]{5,})/gi,
    replacement: "$1[redacted-id]",
  },
  // A bare 9-18 digit run (bank account numbers). Last, so 12-digit Aadhaar / 13-16 digit
  // cards are already labelled by their more specific rules.
  { type: "account", pattern: /\b\d{9,18}\b/g, replacement: "[redacted-account]" },
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
