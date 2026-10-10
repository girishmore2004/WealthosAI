// PURE — no Prisma client, no I/O. Turns the emergency-fund ledger into the pieces the page shows:
// each row with the balance AFTER it, month-by-month balances, and the headline totals. The reserve
// effect of a single entry is the one canonical emergencyReserveDelta(), so this can never disagree
// with the balance FinancialFactsService reports.

import { Prisma } from "@wealthos/db";
import { emergencyReserveDelta } from "../../common/financial-facts/financial-formulas";

type Dec = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export type EntryType = "ALLOCATE" | "RELEASE" | "WITHDRAWAL" | "ADJUSTMENT" | "TRANSFER_IN" | "TRANSFER_OUT";

export interface LedgerEntryInput {
  id: string;
  type: EntryType;
  amount: Prisma.Decimal.Value;
  occurredAt: Date;
  createdAt?: Date;
  reason?: string | null;
  notes?: string | null;
  origin?: string | null;
}

export interface LedgerRow {
  id: string;
  type: EntryType;
  // The amount as entered (positive, except a signed ADJUSTMENT).
  amount: Dec;
  // What it did to the reserve: positive adds, negative takes out.
  effect: Dec;
  balanceAfter: Dec;
  occurredAt: Date;
  reason: string | null;
  notes: string | null;
  origin: string | null;
}

// Money ADDED by the user vs money TAKEN OUT of the reserve. Adjustments are corrections, kept apart
// so a correction never inflates "total contributions".
export const CONTRIBUTION_TYPES: EntryType[] = ["ALLOCATE", "TRANSFER_IN"];
export const WITHDRAWAL_TYPES: EntryType[] = ["WITHDRAWAL", "RELEASE", "TRANSFER_OUT"];

const monthOf = (d: Date): string => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Oldest first, with a stable tiebreak so two entries on one day always run in the order they were made. */
function chronological(entries: LedgerEntryInput[]): LedgerEntryInput[] {
  return [...entries].sort(
    (a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() ||
      (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0) ||
      a.id.localeCompare(b.id),
  );
}

/** Every entry with the running balance after it, NEWEST first (the order the history is read in). */
export function buildLedger(entries: LedgerEntryInput[]): LedgerRow[] {
  let balance = ZERO;
  const rows: LedgerRow[] = chronological(entries).map((e) => {
    const effect = emergencyReserveDelta({ type: e.type, amount: e.amount });
    balance = balance.plus(effect);
    return {
      id: e.id,
      type: e.type,
      amount: new Prisma.Decimal(e.amount),
      effect,
      balanceAfter: balance,
      occurredAt: e.occurredAt,
      reason: e.reason ?? null,
      notes: e.notes ?? null,
      origin: e.origin ?? null,
    };
  });
  return rows.reverse();
}

export interface TrendPoint {
  month: string;
  closingBalance: Dec;
  added: Dec;
  used: Dec;
}

/**
 * The last `months` calendar months ending at `currentMonth` ("2026-10"), oldest first: what was added,
 * what was used, and the balance at the END of each month (carried forward through quiet months).
 */
export function buildTrend(entries: LedgerEntryInput[], months: string[]): TrendPoint[] {
  const sorted = chronological(entries);
  return months.map((month) => {
    let closing = ZERO;
    let added = ZERO;
    let used = ZERO;
    for (const e of sorted) {
      const m = monthOf(e.occurredAt);
      if (m > month) break;
      closing = closing.plus(emergencyReserveDelta({ type: e.type, amount: e.amount }));
      if (m === month) {
        const abs = new Prisma.Decimal(e.amount).abs();
        if (CONTRIBUTION_TYPES.includes(e.type)) added = added.plus(abs);
        else if (WITHDRAWAL_TYPES.includes(e.type)) used = used.plus(abs);
      }
    }
    return { month, closingBalance: closing, added, used };
  });
}

export interface LedgerTotals {
  balance: Dec;
  contributions: Dec;
  withdrawals: Dec;
  adjustments: Dec;
  contributionsThisMonth: Dec;
  contributionsThisYear: Dec;
  withdrawalsThisYear: Dec;
  lastContribution: { occurredAt: Date; amount: Dec } | null;
  lastWithdrawal: { occurredAt: Date; amount: Dec } | null;
}

export function summarizeLedger(entries: LedgerEntryInput[], currentMonth: string): LedgerTotals {
  const year = currentMonth.slice(0, 4);
  const t: LedgerTotals = {
    balance: ZERO,
    contributions: ZERO,
    withdrawals: ZERO,
    adjustments: ZERO,
    contributionsThisMonth: ZERO,
    contributionsThisYear: ZERO,
    withdrawalsThisYear: ZERO,
    lastContribution: null,
    lastWithdrawal: null,
  };

  for (const e of chronological(entries)) {
    const effect = emergencyReserveDelta({ type: e.type, amount: e.amount });
    const abs = new Prisma.Decimal(e.amount).abs();
    const m = monthOf(e.occurredAt);
    t.balance = t.balance.plus(effect);

    if (CONTRIBUTION_TYPES.includes(e.type)) {
      t.contributions = t.contributions.plus(abs);
      if (m === currentMonth) t.contributionsThisMonth = t.contributionsThisMonth.plus(abs);
      if (m.startsWith(year) && m <= currentMonth) t.contributionsThisYear = t.contributionsThisYear.plus(abs);
      t.lastContribution = { occurredAt: e.occurredAt, amount: abs }; // chronological, so the last one wins
    } else if (WITHDRAWAL_TYPES.includes(e.type)) {
      t.withdrawals = t.withdrawals.plus(abs);
      if (m.startsWith(year) && m <= currentMonth) t.withdrawalsThisYear = t.withdrawalsThisYear.plus(abs);
      t.lastWithdrawal = { occurredAt: e.occurredAt, amount: abs };
    } else {
      t.adjustments = t.adjustments.plus(effect);
    }
  }
  return t;
}
