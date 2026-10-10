// PURE — no Prisma client, no I/O. Folds already-aggregated ledger rows (one per holding per month)
// into the portfolio time series the investments page charts. The heavy lifting (grouping by month)
// happens in the database; this only combines at most holdings x months small rows.

import { Prisma } from "@wealthos/db";

type Dec = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);

export type LedgerCashflowType =
  | "CONTRIBUTION"
  | "WITHDRAWAL"
  | "SALE"
  | "DIVIDEND"
  | "FEE"
  | "EMPLOYER_CONTRIBUTION"
  | "INTEREST"
  | "TRANSFER_IN"
  | "TRANSFER_OUT";

/** One database row: the sum of one cashflow type for one holding in one calendar month ("YYYY-MM"). */
export interface MonthlyCashflowRow {
  investmentId: string;
  month: string;
  type: LedgerCashflowType;
  total: Prisma.Decimal.Value;
}

/** The latest valuation a holding had within one calendar month. */
export interface MonthlyValuationRow {
  investmentId: string;
  month: string;
  value: Prisma.Decimal.Value;
}

/** The last `count` calendar months ending at `end` ("2026-10"), oldest first. */
export function monthWindow(end: string, count: number): string[] {
  const [y, m] = end.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return out;
}

// Money put in by (or for) the holding vs money that came back out of it.
const IN_TYPES: LedgerCashflowType[] = ["CONTRIBUTION", "EMPLOYER_CONTRIBUTION", "TRANSFER_IN"];
const OUT_TYPES: LedgerCashflowType[] = ["WITHDRAWAL", "SALE", "TRANSFER_OUT"];

export interface InvestmentSeries {
  contributionTrend: Array<{ month: string; contributions: Dec; employer: Dec; withdrawals: Dec }>;
  valueTrend: Array<{ month: string; value: Dec | null; holdingsValued: number }>;
  gainTrend: Array<{ month: string; gain: Dec | null; coveredHoldings: number }>;
  // Own contributions recorded this calendar month / year, from ALL history (not just the window).
  contributionsThisMonth: Dec;
  contributionsThisYear: Dec;
  holdingsWithLedger: number;
}

export function buildInvestmentSeries(months: string[], cash: MonthlyCashflowRow[], valuations: MonthlyValuationRow[], currentMonth: string): InvestmentSeries {
  const dec = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

  // Per-holding, per-month net money in, and the set of holdings that have any ledger at all.
  const netByHolding = new Map<string, Map<string, Dec>>();
  const withLedger = new Set<string>();
  const windowContrib = new Map<string, { contributions: Dec; employer: Dec; withdrawals: Dec }>();
  let thisMonth = ZERO;
  let thisYear = ZERO;
  const year = currentMonth.slice(0, 4);

  for (const r of cash) {
    const amount = dec(r.total);
    withLedger.add(r.investmentId);

    const signed = IN_TYPES.includes(r.type) ? amount : OUT_TYPES.includes(r.type) ? amount.negated() : ZERO;
    if (!signed.isZero()) {
      const byMonth = netByHolding.get(r.investmentId) ?? new Map<string, Dec>();
      byMonth.set(r.month, (byMonth.get(r.month) ?? ZERO).plus(signed));
      netByHolding.set(r.investmentId, byMonth);
    }

    if (r.type === "CONTRIBUTION") {
      if (r.month === currentMonth) thisMonth = thisMonth.plus(amount);
      if (r.month.startsWith(year) && r.month <= currentMonth) thisYear = thisYear.plus(amount);
    }

    if (months.includes(r.month)) {
      const w = windowContrib.get(r.month) ?? { contributions: ZERO, employer: ZERO, withdrawals: ZERO };
      if (r.type === "CONTRIBUTION") w.contributions = w.contributions.plus(amount);
      else if (r.type === "EMPLOYER_CONTRIBUTION") w.employer = w.employer.plus(amount);
      else if (r.type === "WITHDRAWAL" || r.type === "SALE") w.withdrawals = w.withdrawals.plus(amount);
      windowContrib.set(r.month, w);
    }
  }

  // Valuations per holding, oldest month first, so "the latest at or before month M" is a simple scan.
  const valsByHolding = new Map<string, MonthlyValuationRow[]>();
  for (const v of valuations) {
    const list = valsByHolding.get(v.investmentId) ?? [];
    list.push(v);
    valsByHolding.set(v.investmentId, list);
  }
  for (const list of valsByHolding.values()) list.sort((a, b) => a.month.localeCompare(b.month));

  const valueAt = (investmentId: string, month: string): Dec | null => {
    let latest: Dec | null = null;
    for (const v of valsByHolding.get(investmentId) ?? []) {
      if (v.month > month) break;
      latest = dec(v.value);
    }
    return latest;
  };
  const netInvestedAt = (investmentId: string, month: string): Dec => {
    let total = ZERO;
    for (const [m, amount] of netByHolding.get(investmentId) ?? []) if (m <= month) total = total.plus(amount);
    return total;
  };

  const contributionTrend = months.map((month) => {
    const w = windowContrib.get(month) ?? { contributions: ZERO, employer: ZERO, withdrawals: ZERO };
    return { month, ...w };
  });

  const valueTrend: InvestmentSeries["valueTrend"] = [];
  const gainTrend: InvestmentSeries["gainTrend"] = [];
  for (const month of months) {
    let total = ZERO;
    let valued = 0;
    let gain = ZERO;
    let covered = 0;
    for (const id of valsByHolding.keys()) {
      const value = valueAt(id, month);
      if (value === null) continue;
      total = total.plus(value);
      valued += 1;
      // A gain is only meaningful where we know BOTH what the holding is worth and what went in.
      if (withLedger.has(id)) {
        gain = gain.plus(value.minus(netInvestedAt(id, month)));
        covered += 1;
      }
    }
    valueTrend.push({ month, value: valued > 0 ? total : null, holdingsValued: valued });
    gainTrend.push({ month, gain: covered > 0 ? gain : null, coveredHoldings: covered });
  }

  return { contributionTrend, valueTrend, gainTrend, contributionsThisMonth: thisMonth, contributionsThisYear: thisYear, holdingsWithLedger: withLedger.size };
}
