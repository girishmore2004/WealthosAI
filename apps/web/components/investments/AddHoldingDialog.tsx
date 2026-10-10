"use client";

import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import type { InvestmentType, Liquidity, RiskLevel } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { localDateString } from "@/lib/dates";

export const INVESTMENT_TYPES: InvestmentType[] = ["MUTUAL_FUND", "STOCK", "ETF", "EPF", "PPF", "NPS", "FD", "BOND", "GOLD", "SILVER", "REAL_ESTATE", "CRYPTO", "BUSINESS_EQUITY", "OTHER"];
export const RISK_LEVELS: RiskLevel[] = ["LOW", "MODERATE", "HIGH"];
export const LIQUIDITY_LEVELS: Liquidity[] = ["LIQUID", "SEMI_LIQUID", "ILLIQUID"];

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";
const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase();

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-soft">
        {label}
      </label>
      {children}
    </div>
  );
}

export function AddHoldingDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [type, setType] = useState<InvestmentType>("MUTUAL_FUND");
  const [name, setName] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => localDateString());
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("MODERATE");
  const [liquidity, setLiquidity] = useState<Liquidity>("SEMI_LIQUID");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType("MUTUAL_FUND");
    setName("");
    setCurrentValue("");
    setCostBasis("");
    setPurchaseDate(localDateString());
    setRiskLevel("MODERATE");
    setLiquidity("SEMI_LIQUID");
    setError(null);
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const cv = parseFloat(currentValue);
    const cb = parseFloat(costBasis);
    if (!name.trim()) return setError("Give this holding a name.");
    if (!Number.isFinite(cv) || cv < 0 || !Number.isFinite(cb) || cb < 0) return setError("Enter the current value and the amount invested (zero or more).");
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.create({ type, name: name.trim(), currentValue: cv, costBasis: cb, purchaseDate: new Date(purchaseDate).toISOString(), riskLevel, liquidity });
      emitFinancialChange("investment");
      onSaved(`${name.trim()} added. Record its contributions and values to track it over time.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this holding.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a holding">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("type")} label="Type">
            <select id={id("type")} value={type} onChange={(e) => setType(e.target.value as InvestmentType)} className={selectClass}>
              {INVESTMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {pretty(t)}
                </option>
              ))}
            </select>
          </Field>
          <Field id={id("name")} label="Name">
            <Input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Nifty 50 Index Fund" required />
          </Field>
          <Field id={id("invested")} label="Amount invested so far (₹)">
            <Input id={id("invested")} type="number" inputMode="decimal" min="0" step="0.01" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} className="money" required />
          </Field>
          <Field id={id("value")} label="Worth now (₹)">
            <Input id={id("value")} type="number" inputMode="decimal" min="0" step="0.01" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} className="money" required />
          </Field>
          <Field id={id("date")} label="Purchase date">
            <Input id={id("date")} type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
          </Field>
          <Field id={id("risk")} label="Risk">
            <select id={id("risk")} value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as RiskLevel)} className={selectClass}>
              {RISK_LEVELS.map((r) => (
                <option key={r} value={r}>
                  {pretty(r)} risk
                </option>
              ))}
            </select>
          </Field>
          <Field id={id("liq")} label="Liquidity">
            <select id={id("liq")} value={liquidity} onChange={(e) => setLiquidity(e.target.value as Liquidity)} className={selectClass}>
              {LIQUIDITY_LEVELS.map((l) => (
                <option key={l} value={l}>
                  {pretty(l)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add holding"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
