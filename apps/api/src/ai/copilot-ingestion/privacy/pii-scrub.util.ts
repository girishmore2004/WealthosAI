// Scrubs obvious PII shapes (card/account numbers, phone numbers, emails, PAN-shaped
// strings) out of raw statement text before it is persisted for audit purposes
// (IngestionBatch.rawTextExcerpt, IngestionReviewItem.rawLine). This is a deliberately
// separate, narrower implementation from AiModule's RedactionService rather than a
// reuse of it — RedactionService is not in AiModule's `exports` array (only
// AiGatewayService/AiQueueService/AiCacheService/PromptRegistryService are), and
// widening another feature's module surface for this one call site is the same
// tradeoff copilot-ingestion.module.ts already documents choosing against elsewhere
// (see the AnomalyDetectionModel comment there). Every LLM call this feature makes
// already goes through AiGatewayService, which applies RedactionService's full rules
// automatically before anything reaches the model — this util only covers the
// separate, narrower concern of what gets written to the database for audit/debugging
// display, which was previously stored completely unredacted.
const PII_SCRUB_RULES: { pattern: RegExp; replacement: string }[] = [
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{1,4}\b/g, replacement: "[REDACTED_CARD]" }, // 13-19 digit card-shaped numbers
  { pattern: /\b\d{9,18}\b/g, replacement: "[REDACTED_ACCOUNT]" }, // long bare digit runs (account/reference numbers)
  { pattern: /\b[6-9]\d{9}\b/g, replacement: "[REDACTED_PHONE]" }, // Indian 10-digit mobile numbers
  { pattern: /[\w.+-]+@[\w-]+\.[a-zA-Z]{2,}/g, replacement: "[REDACTED_EMAIL]" },
  { pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/g, replacement: "[REDACTED_PAN]" }, // Indian PAN format
];

export function scrubPii(text: string): string {
  let scrubbed = text;
  for (const rule of PII_SCRUB_RULES) {
    scrubbed = scrubbed.replace(rule.pattern, rule.replacement);
  }
  return scrubbed;
}
