import { RULE_BASED_FALLBACK_CONFIDENCE } from "../copilot-ingestion.constants";

export interface RuleBasedSuggestion {
  categoryId: string;
  categoryName: string;
  confidence: number;
}

// Ordered, explicit keyword -> category-name-substring rules. Purely deterministic
// pattern matching against a merchant string that has already been through
// normalizeMerchantText() — no AI call, no network, always available. This is the
// last-resort fallback used only when (a) personal merchant memory has nothing
// reliable for this merchant AND (b) the AI Gateway is unavailable (AiUnavailableException)
// — see category-suggestion.service.ts. It NEVER invents a category: a rule only ever
// returns a match if the user's own category list already contains a category whose
// name contains one of the rule's hint substrings, so the same "structurally cannot
// suggest a nonexistent category" guarantee the AI classify() path has is preserved
// here. Confidence is fixed and deliberately low (RULE_BASED_FALLBACK_CONFIDENCE) —
// this is an honest, low-trust guess, not presented as AI-quality output.
const CATEGORY_KEYWORD_RULES: { pattern: RegExp; nameHints: string[] }[] = [
  { pattern: /\b(UBER|OLA|RAPIDO|IRCTC|REDBUS|METRO|PETROL|FUEL|INDIAN\s*OIL|HPCL|BPCL|IOCL)\b/i, nameHints: ["transport", "travel", "fuel", "commute"] },
  { pattern: /\b(SWIGGY|ZOMATO|RESTAURANT|CAFE|DOMINOS|MCDONALD|KFC|STARBUCKS|EATERY|DHABA)\b/i, nameHints: ["food", "dining", "restaurant", "eating out"] },
  { pattern: /\b(BIGBASKET|GROFERS|BLINKIT|ZEPTO|DMART|RELIANCE\s*FRESH|GROCERY|SUPERMARKET|KIRANA)\b/i, nameHints: ["grocery", "groceries"] },
  { pattern: /\b(NETFLIX|HOTSTAR|SPOTIFY|PRIME\s*VIDEO|SONYLIV|YOUTUBE\s*PREMIUM)\b/i, nameHints: ["subscription", "entertainment", "streaming"] },
  { pattern: /\b(ELECTRICITY|WATER\s*BILL|GAS\s*BILL|BROADBAND|AIRTEL|JIO|VODAFONE|BSNL|UTILITY)\b/i, nameHints: ["utility", "utilities", "bill"] },
  { pattern: /\b(RENT|LANDLORD|LEASE)\b/i, nameHints: ["rent", "housing"] },
  { pattern: /\b(PHARMACY|HOSPITAL|CLINIC|APOLLO|MEDPLUS|DIAGNOSTIC|MEDICAL)\b/i, nameHints: ["health", "medical", "pharmacy"] },
  { pattern: /\b(EMI|LOAN)\b/i, nameHints: ["loan", "emi", "debt"] },
  { pattern: /\b(SIP|MUTUAL\s*FUND|ZERODHA|GROWW|UPSTOX|NPS|PPF)\b/i, nameHints: ["investment", "sip"] },
  { pattern: /\b(AMAZON|FLIPKART|MYNTRA|AJIO|SHOPPING|MALL)\b/i, nameHints: ["shopping"] },
  { pattern: /\b(INSURANCE|LIC|PREMIUM)\b/i, nameHints: ["insurance"] },
];

export function ruleBasedCategorySuggestion(
  merchantNormalized: string,
  categories: { id: string; name: string }[],
): RuleBasedSuggestion | null {
  for (const rule of CATEGORY_KEYWORD_RULES) {
    if (!rule.pattern.test(merchantNormalized)) continue;

    const match = categories.find((c) => rule.nameHints.some((hint) => c.name.toLowerCase().includes(hint)));
    if (match) {
      return { categoryId: match.id, categoryName: match.name, confidence: RULE_BASED_FALLBACK_CONFIDENCE };
    }
  }
  return null;
}
