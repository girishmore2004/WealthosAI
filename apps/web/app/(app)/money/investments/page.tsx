"use client";

import { useEffect, useState, FormEvent } from "react";
import type { InvestmentDTO, InvestmentSummaryDTO, InvestmentType, RiskLevel, Liquidity } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { RebalancePanel } from "@/components/investments/RebalancePanel";
import { formatINR, formatPercent } from "@/lib/format";

const TYPES: InvestmentType[] = [
  "MUTUAL_FUND",
  "STOCK",
  "ETF",
  "EPF",
  "PPF",
  "NPS",
  "FD",
  "BOND",
  "GOLD",
  "SILVER",
  "REAL_ESTATE",
  "CRYPTO",
  "BUSINESS_EQUITY",
  "OTHER",
];
const RISK_LEVELS: RiskLevel[] = ["LOW", "MODERATE", "HIGH"];
const LIQUIDITY_LEVELS: Liquidity[] = ["LIQUID", "SEMI_LIQUID", "ILLIQUID"];

const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
  { key: "name", label: "Name" },
  { key: "currentValue", label: "Current value (₹)", type: "number", money: true },
  { key: "costBasis", label: "Cost basis (₹)", type: "number", money: true },
  { key: "purchaseDate", label: "Purchase date", type: "date" },
  { key: "riskLevel", label: "Risk level", type: "select", options: RISK_LEVELS.map((r) => ({ value: r, label: r })) },
  { key: "liquidity", label: "Liquidity", type: "select", options: LIQUIDITY_LEVELS.map((l) => ({ value: l, label: l })) },
];

export default function InvestmentsPage() {
  const [items, setItems] = useState<InvestmentDTO[]>([]);
  const [summary, setSummary] = useState<InvestmentSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<InvestmentType>("MUTUAL_FUND");
  const [name, setName] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [costBasis, setCostBasis] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [riskLevel, setRiskLevel] = useState<RiskLevel>("MODERATE");
  const [liquidity, setLiquidity] = useState<Liquidity>("SEMI_LIQUID");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.investments.list(), api.investments.summary()])
      .then(([list, summary]) => {
        setItems(list);
        setSummary(summary);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load investments."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.create({
        type,
        name,
        currentValue: parseFloat(currentValue),
        costBasis: parseFloat(costBasis),
        purchaseDate: new Date(purchaseDate).toISOString(),
        riskLevel,
        liquidity,
      });
      setName("");
      setCurrentValue("");
      setCostBasis("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this holding.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.investments.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.investments.update(id, {
      type: values.type as string,
      name: values.name as string,
      currentValue: parseFloat(values.currentValue as string),
      costBasis: parseFloat(values.costBasis as string),
      purchaseDate: new Date(values.purchaseDate as string).toISOString(),
      riskLevel: values.riskLevel as string,
      liquidity: values.liquidity as string,
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Investments</h1>
        <p className="text-sm text-ink-soft">Mutual funds, stocks, EPF/PPF/NPS, gold, real estate, and more.</p>
      </div>

      {summary && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Portfolio value">
            <div className="flex items-baseline justify-between">
              <span className="money text-2xl text-ink">{formatINR(summary.totalCurrentValue)}</span>
              <span className={`money text-sm ${summary.totalGainLossPercent >= 0 ? "text-gain" : "text-loss"}`}>
                {summary.totalGainLossPercent >= 0 ? "+" : ""}
                {formatPercent(summary.totalGainLossPercent)}
              </span>
            </div>
            <p className="mt-1 text-xs text-ink-faint">
              Cost basis {formatINR(summary.totalCostBasis)} · Gain/loss {formatINR(summary.totalGainLoss)}
            </p>
          </Card>
          <Card title="Allocation">
            <ul className="space-y-1">
              {summary.allocation.slice(0, 5).map((a) => (
                <li key={a.type} className="flex justify-between text-xs">
                  <span className="text-ink-soft">{a.type.replace("_", " ").toLowerCase()}</span>
                  <span className="money text-ink">{a.percent}%</span>
                </li>
              ))}
              {summary.allocation.length === 0 && <p className="text-xs text-ink-faint">No holdings yet.</p>}
            </ul>
          </Card>
        </div>
      )}

      {summary && <RebalancePanel summary={summary} allTypes={TYPES} />}

      <Card title="Add holding">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select value={type} onChange={(e) => setType(e.target.value as InvestmentType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Name (e.g. Nifty 50 Index Fund)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
          <Input type="number" min="0" step="0.01" placeholder="Current value (₹)" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} required className="money" />
          <Input type="number" min="0" step="0.01" placeholder="Cost basis / invested (₹)" value={costBasis} onChange={(e) => setCostBasis(e.target.value)} required className="money" />
          <select value={riskLevel} onChange={(e) => setRiskLevel(e.target.value as RiskLevel)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {RISK_LEVELS.map((r) => (
              <option key={r} value={r}>
                {r.toLowerCase()} risk
              </option>
            ))}
          </select>
          <select value={liquidity} onChange={(e) => setLiquidity(e.target.value as Liquidity)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {LIQUIDITY_LEVELS.map((l) => (
              <option key={l} value={l}>
                {l.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add holding"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <Card title="All holdings">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No holdings logged yet.</p>
        ) : (
          <ul>
            {items.map((item, i) => {
              const gain = Number(item.currentValue) - Number(item.costBasis);
              return (
                <li key={item.id} className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                  {editingId === item.id ? (
                    <InlineEditForm
                      fields={EDIT_FIELDS}
                      initialValues={{
                        type: item.type,
                        name: item.name,
                        currentValue: item.currentValue,
                        costBasis: item.costBasis,
                        purchaseDate: item.purchaseDate.slice(0, 10),
                        riskLevel: item.riskLevel,
                        liquidity: item.liquidity,
                      }}
                      onSave={(values) => onUpdate(item.id, values)}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-ink">{item.name}</p>
                        <p className="text-xs text-ink-faint">
                          {item.type.replace("_", " ").toLowerCase()} · {item.riskLevel.toLowerCase()} risk · {item.liquidity.replace("_", " ").toLowerCase()}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="money text-ink">{formatINR(item.currentValue)}</p>
                          <p className={`money text-xs ${gain >= 0 ? "text-gain" : "text-loss"}`}>
                            {gain >= 0 ? "+" : ""}
                            {formatINR(gain)}
                          </p>
                        </div>
                        <button onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                          Edit
                        </button>
                        <button onClick={() => onDelete(item.id)} className="text-xs text-ink-faint hover:text-loss">
                          Remove
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
