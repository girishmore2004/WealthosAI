"use client";

import { useState } from "react";
import type { InvestmentSummaryDTO, InvestmentType, RebalancePlanDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

const ACTION_STYLES: Record<RebalancePlanDTO["actions"][number]["action"], string> = {
  BUY: "text-gain",
  SELL: "text-loss",
  HOLD: "text-ink-faint",
};

export function RebalancePanel({ summary, allTypes }: { summary: InvestmentSummaryDTO; allTypes: InvestmentType[] }) {
  const [open, setOpen] = useState(false);
  const [targets, setTargets] = useState<Record<string, string>>(() =>
    Object.fromEntries(allTypes.map((t) => [t, String(summary.allocation.find((a) => a.type === t)?.percent ?? 0)])),
  );
  const [cashAvailable, setCashAvailable] = useState("0");
  const [noSellTypes, setNoSellTypes] = useState<Set<string>>(new Set());
  const [plan, setPlan] = useState<RebalancePlanDTO | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heldTypes = summary.allocation.map((a) => a.type);
  const targetSum = Object.values(targets).reduce((sum, v) => sum + (parseFloat(v) || 0), 0);

  const toggleNoSell = (type: string) => {
    setNoSellTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const onSubmit = async () => {
    setSubmitting(true);
    setError(null);
    setPlan(null);
    try {
      const result = await api.investments.rebalance({
        targets: Object.entries(targets)
          .filter(([, v]) => parseFloat(v) > 0)
          .map(([type, v]) => ({ type, percent: parseFloat(v) })),
        cashAvailable: parseFloat(cashAvailable) || 0,
        noSellTypes: Array.from(noSellTypes),
      });
      setPlan(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not compute a rebalance plan.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) {
    return (
      <Card title="Rebalance">
        <p className="text-sm text-ink-soft">
          Set a target allocation and see exactly what to buy or sell to get there — including how to deploy any new
          cash without selling anything.
        </p>
        <Button variant="secondary" className="mt-3" onClick={() => setOpen(true)}>
          Plan a rebalance
        </Button>
      </Card>
    );
  }

  return (
    <Card title="Rebalance" action={<Button variant="secondary" onClick={() => setOpen(false)}>Close</Button>}>
      <p className="text-xs text-ink-faint">
        Target percentages must add up to 100%. Currently: <span className={targetSum === 100 ? "text-ink" : "text-loss"}>{targetSum.toFixed(1)}%</span>
      </p>
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        {allTypes
          .filter((t) => heldTypes.includes(t) || parseFloat(targets[t]) > 0)
          .map((t) => (
            <div key={t} className="flex items-center gap-2">
              <span className="w-32 shrink-0 text-xs text-ink-soft">{label(t)}</span>
              <Input
                type="number"
                min="0"
                max="100"
                value={targets[t]}
                onChange={(e) => setTargets((prev) => ({ ...prev, [t]: e.target.value }))}
                className="w-20"
              />
              <span className="text-xs text-ink-faint">%</span>
              {heldTypes.includes(t) && (
                <label className="ml-2 flex items-center gap-1 text-[11px] text-ink-faint">
                  <input type="checkbox" checked={noSellTypes.has(t)} onChange={() => toggleNoSell(t)} className="h-3 w-3" />
                  don&apos;t sell
                </label>
              )}
            </div>
          ))}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <span className="text-xs text-ink-soft">New cash to deploy (₹)</span>
        <Input type="number" min="0" value={cashAvailable} onChange={(e) => setCashAvailable(e.target.value)} className="w-32 money" />
      </div>

      {error && <p className="mt-2 text-sm text-loss">{error}</p>}

      <Button className="mt-3" onClick={onSubmit} disabled={submitting || Math.abs(targetSum - 100) > 0.5}>
        {submitting ? "Computing…" : "Compute plan"}
      </Button>

      {plan && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-xs text-ink-faint">
            Total after cash: {formatINR(plan.totalAfterCash)} · Total to buy: {formatINR(plan.totalBuy)} · Total to
            sell: {formatINR(plan.totalSell)}
          </p>
          <ul className="mt-2 space-y-1.5">
            {plan.actions.map((a) => (
              <li key={a.type} className="flex items-center justify-between text-sm ledger-rule py-1.5">
                <span className="text-ink-soft">
                  {label(a.type)} — {a.currentPercent}% → {a.targetPercent}%{a.constrained ? " (constrained)" : ""}
                </span>
                <span className={`money font-medium ${ACTION_STYLES[a.action]}`}>
                  {a.action}
                  {a.amount > 0 ? ` ${formatINR(a.amount)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
