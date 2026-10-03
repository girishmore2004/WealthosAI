// Pure planning logic for migrating legacy SAVINGS-category Expense rows into the new
// financial model. No database access — everything the planner needs is passed in, so the
// classification rules are unit-testable and the dry run and the real run can never
// disagree about what "would be migrated".
//
// Rules (conservative on purpose — spec: "Do not guess ambiguous historical data"):
//   * Category name mentions "emergency"         -> EmergencyFundEntry(ALLOCATE)
//   * Any other SAVINGS expense                  -> InvestmentCashflow(CONTRIBUTION), but ONLY
//     when exactly one of the user's investments matches the expense's merchant/notes.
//     Zero or several matches -> WARNING (left untouched for the user to resolve).
//   * Already migrated (a cashflow/entry already points at the expense) -> SKIPPED
//   * Same investment + month already has a contribution -> DUPLICATE (same amount) or
//     WARNING (different amount); never silently merged.
// The original Expense row is never modified or deleted.

export type MigrationStatus = "MIGRATED" | "SKIPPED" | "DUPLICATE" | "WARNING" | "ERROR";
export type MigrationTarget = "INVESTMENT_CONTRIBUTION" | "EMERGENCY_ALLOCATION" | "NONE";

export interface LegacyExpenseInput {
  id: string;
  amount: string; // decimal string — never a float
  spentAt: Date;
  merchant: string | null;
  notes: string | null;
  categoryName: string;
}

export interface InvestmentRef {
  id: string;
  name: string;
}

export interface ExistingContributionRef {
  investmentId: string;
  occurredAt: Date;
  amount: string;
}

export interface PlannerInput {
  expenses: LegacyExpenseInput[];
  investments: InvestmentRef[];
  alreadyMigratedExpenseIds: Set<string>;
  existingContributions: ExistingContributionRef[];
}

export interface PlannedItem {
  expenseId: string;
  status: MigrationStatus; // in a dry run, MIGRATED means "would be migrated"
  target: MigrationTarget;
  investmentId?: string;
  periodKey?: string;
  amount: string;
  reason: string;
}

export const monthKey = (d: Date): string =>
  `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

const norm = (s: string | null | undefined): string =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

// Generic words that appear in almost every fund name and would make everything match.
const STOP = new Set(["fund", "direct", "growth", "plan", "regular", "scheme", "sip", "the", "of", "and", "mutual"]);
const tokens = (s: string): string[] => norm(s).split(" ").filter((t) => t.length > 1 && !STOP.has(t));

/**
 * An investment matches when the expense text contains the investment's full normalized
 * name, or every distinctive token of the investment's name. Deliberately strict: a loose
 * match could attach a contribution to the wrong holding.
 */
export function matchesInvestment(text: string, inv: InvestmentRef): boolean {
  const t = norm(text);
  const name = norm(inv.name);
  if (!t || !name) return false;
  if (t.includes(name)) return true;
  const need = tokens(inv.name);
  if (need.length === 0) return false;
  const have = new Set(tokens(text));
  return need.every((tok) => have.has(tok));
}

const isEmergencyCategory = (name: string): boolean => /emergency/i.test(name);

export function planLegacyMigration(input: PlannerInput): PlannedItem[] {
  const out: PlannedItem[] = [];
  // Occupied (investment, month) slots: pre-existing contributions + ones planned earlier
  // in THIS run, so two legacy rows for one month can't both be migrated.
  const slots = new Map<string, string>();
  for (const c of input.existingContributions) slots.set(`${c.investmentId}|${monthKey(c.occurredAt)}`, c.amount);

  const ordered = [...input.expenses].sort((a, b) => a.spentAt.getTime() - b.spentAt.getTime() || a.id.localeCompare(b.id));

  for (const e of ordered) {
    const base = { expenseId: e.id, amount: e.amount };

    if (input.alreadyMigratedExpenseIds.has(e.id)) {
      out.push({ ...base, status: "SKIPPED", target: "NONE", reason: "Already migrated." });
      continue;
    }

    if (isEmergencyCategory(e.categoryName)) {
      out.push({
        ...base,
        status: "MIGRATED",
        target: "EMERGENCY_ALLOCATION",
        reason: "Emergency-fund expense -> reserve allocation.",
      });
      continue;
    }

    const text = `${e.merchant ?? ""} ${e.notes ?? ""}`;
    const matches = input.investments.filter((inv) => matchesInvestment(text, inv));

    if (matches.length === 0) {
      out.push({
        ...base,
        status: "WARNING",
        target: "NONE",
        reason: "No investment could be matched from the merchant/notes. Link it manually; nothing was guessed.",
      });
      continue;
    }
    if (matches.length > 1) {
      out.push({
        ...base,
        status: "WARNING",
        target: "NONE",
        reason: `Ambiguous: matches ${matches.length} investments. Link it manually; nothing was guessed.`,
      });
      continue;
    }

    const inv = matches[0];
    const period = monthKey(e.spentAt);
    const slot = `${inv.id}|${period}`;
    const existing = slots.get(slot);
    if (existing !== undefined) {
      const same = Number(existing) === Number(e.amount);
      out.push({
        ...base,
        status: same ? "DUPLICATE" : "WARNING",
        target: "NONE",
        investmentId: inv.id,
        periodKey: period,
        reason: same
          ? "A contribution of the same amount already exists for this investment and month; not duplicated."
          : "A different contribution already exists for this investment and month; needs manual review.",
      });
      continue;
    }

    slots.set(slot, e.amount);
    out.push({
      ...base,
      status: "MIGRATED",
      target: "INVESTMENT_CONTRIBUTION",
      investmentId: inv.id,
      periodKey: period,
      reason: "SIP/investment expense -> investment contribution.",
    });
  }
  return out;
}

export interface MigrationSummary {
  MIGRATED: number;
  SKIPPED: number;
  DUPLICATE: number;
  WARNING: number;
  ERROR: number;
}

export const summarize = (items: Array<{ status: MigrationStatus }>): MigrationSummary =>
  items.reduce<MigrationSummary>(
    (acc, i) => ({ ...acc, [i.status]: acc[i.status] + 1 }),
    { MIGRATED: 0, SKIPPED: 0, DUPLICATE: 0, WARNING: 0, ERROR: 0 },
  );
