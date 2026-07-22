import { MERCHANT_NOISE_PATTERNS } from "../copilot-ingestion.constants";

/** Strips common statement noise (POS/UPI/NEFT prefixes, trailing reference numbers,
 * masked card suffixes) and normalizes whitespace/casing for display — the
 * mechanical part of "merchant normalization" that's genuinely rule-based, not a
 * model guess. Returns a title-cased, trimmed string; e.g. "POS AMAZON.IN 4829102"
 * → "Amazon.in". */
export function normalizeMerchantText(raw: string): string {
  let cleaned = raw;
  for (const pattern of MERCHANT_NOISE_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim();

  if (!cleaned) return raw.trim();

  // Title-case each word, but leave words that are already mixed-case (e.g.
  // "Amazon.in", "PayTM") untouched — a blunt toUpperCase-then-titlecase would
  // destroy a merchant's actual stylization.
  return cleaned
    .split(" ")
    .map((word) => (word === word.toUpperCase() ? capitalize(word.toLowerCase()) : word))
    .join(" ");
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/** Groups a batch of raw merchant strings by their normalized form — used to spot
 * that "POS AMAZON.IN 4829102" and "POS AMAZON.IN 5810293" (different trailing
 * reference numbers) are the same merchant, purely from the deterministic
 * normalization, before any model is involved. */
export function groupByNormalizedMerchant<T extends { merchantRaw: string }>(items: T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = normalizeMerchantText(item.merchantRaw).toLowerCase();
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  return groups;
}
