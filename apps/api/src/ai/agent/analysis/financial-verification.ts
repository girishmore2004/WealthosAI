import type { ToolResult } from "../../financial-engine/financial-types";
import { reconcileTotal, round2, sumMoney } from "./financial-math";

// Agent-layer arithmetic verification. The finance engine's own verifier checks that every number in a sentence exists
// somewhere in its facts, but it never adds the listed rows up and compares them with the total printed next to them.
// This module does that, in code, for the aggregates the agent presents. It never edits a source figure: it reports the
// discrepancy, shows both numbers and says which source needs review.

export interface AggregateDiscrepancy {
  tool: string;
  label: string;
  reportedTotal: number;
  calculatedTotal: number;
  difference: number;
  components: { label: string; value: number }[];
  message: string;
}

interface AggregateRule {
  tool: string;
  rowKey: string;
  totalKey: string;
  label: string;
  /** What each side measures, so the explanation names the source that needs review instead of blaming the arithmetic. */
  rowMeaning: string;
  totalMeaning: string;
}

// Explicit, not inferred: a total is only compared with rows when we know they are meant to measure the same thing.
const AGGREGATE_RULES: AggregateRule[] = [
  {
    tool: "getInsuranceSummary",
    rowKey: "premium",
    totalKey: "totalPremiumsRecorded",
    label: "insurance premiums",
    rowMeaning: "each policy's current premium amount",
    totalMeaning: "the premium payments recorded in your expense ledger",
  },
];

export const formatMoney = (n: number): string => {
  const v = round2(n);
  const body = new Intl.NumberFormat("en-IN", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 }).format(Math.abs(v));
  return `${v < 0 ? "−" : ""}₹${body}`;
};

export function reconcileToolResultAggregates(results: readonly ToolResult[], toleranceRupees = 1): AggregateDiscrepancy[] {
  const out: AggregateDiscrepancy[] = [];
  for (const r of results) {
    for (const rule of AGGREGATE_RULES) {
      if (r.tool !== rule.tool) continue;
      const total = r.facts[rule.totalKey];
      const rows = (r.rows ?? []).filter((row) => row.facts[rule.rowKey]);
      if (!total || rows.length === 0) continue;
      const components = rows.map((row) => ({ label: row.label, value: Number(row.facts[rule.rowKey].value) })).filter((c) => Number.isFinite(c.value));
      const rec = reconcileTotal(components.map((c) => c.value), Number(total.value), toleranceRupees);
      if (rec.reconciles) continue;
      out.push({
        tool: r.tool,
        label: rule.label,
        reportedTotal: rec.reportedTotal,
        calculatedTotal: rec.calculatedTotal,
        difference: rec.difference,
        components,
        message:
          `The reported ${rule.label} total (${formatMoney(rec.reportedTotal)}) does not equal the sum of the listed amounts ` +
          `(${components.map((c) => formatMoney(c.value)).join(" + ")} = ${formatMoney(rec.calculatedTotal)}); the difference is ${formatMoney(Math.abs(rec.difference))}. ` +
          `The total counts ${rule.totalMeaning}, while the list shows ${rule.rowMeaning}. Please review the ${rule.label} records; nothing has been changed.`,
      });
    }
  }
  return out;
}

/** Sums components, labels the result as calculated, and flags any mismatch with a figure someone else reported. */
export function verifyAggregate(label: string, components: readonly { label: string; value: number }[], reported?: number): { calculated: number; verified: boolean; note: string | null } {
  const calculated = sumMoney(components.map((c) => c.value));
  if (reported === undefined) return { calculated, verified: true, note: null };
  const rec = reconcileTotal(components.map((c) => c.value), reported);
  return rec.reconciles ? { calculated, verified: true, note: null } : { calculated, verified: false, note: `${label}: reported ${formatMoney(reported)} but the components add up to ${formatMoney(calculated)} (difference ${formatMoney(Math.abs(rec.difference))}).` };
}
