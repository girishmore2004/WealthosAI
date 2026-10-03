// Pure helpers for premium-period keys. The key is the idempotency component of
// Expense(sourceType = "INSURANCE_PREMIUM", sourceId = policyId, sourceReference = period),
// so the same policy + period can only ever have ONE linked expense — whether it was
// entered by hand or generated.

export const INSURANCE_PREMIUM_SOURCE = "INSURANCE_PREMIUM";
export const INSURANCE_PREMIUM_CATEGORY = "Insurance Premium";

export type PremiumFrequency = "ONE_TIME" | "WEEKLY" | "MONTHLY" | "QUARTERLY" | "YEARLY";

const pad = (n: number) => String(n).padStart(2, "0");

/** ISO-8601 week number (Mon-start) and its week-year. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7) };
}

/**
 * The premium period a date falls in, per the policy's frequency:
 *   MONTHLY "2026-09", QUARTERLY "2026-Q3", YEARLY "2026", WEEKLY "2026-W37",
 *   ONE_TIME "ONE_TIME" (a single-premium policy has exactly one premium).
 */
export function premiumPeriodKey(frequency: PremiumFrequency, date: Date): string {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  switch (frequency) {
    case "MONTHLY":
      return `${y}-${pad(m)}`;
    case "QUARTERLY":
      return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    case "YEARLY":
      return `${y}`;
    case "WEEKLY": {
      const w = isoWeek(date);
      return `${w.year}-W${pad(w.week)}`;
    }
    case "ONE_TIME":
      return "ONE_TIME";
  }
}

const PERIOD_PATTERNS: Record<PremiumFrequency, RegExp> = {
  MONTHLY: /^\d{4}-(0[1-9]|1[0-2])$/,
  QUARTERLY: /^\d{4}-Q[1-4]$/,
  YEARLY: /^\d{4}$/,
  WEEKLY: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/,
  ONE_TIME: /^ONE_TIME$/,
};

/** True when an explicitly supplied period string is valid for the policy's frequency. */
export const isValidPremiumPeriod = (frequency: PremiumFrequency, period: string): boolean =>
  PERIOD_PATTERNS[frequency].test(period);
