"use client";

import { useEffect, useState, FormEvent } from "react";
import type { PropertyPortfolioSummaryDTO, PropertyType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR, formatPercent } from "@/lib/format";

const TYPES: PropertyType[] = ["HOUSE", "APARTMENT", "PLOT", "LAND", "COMMERCIAL", "RENTAL"];

const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
  { key: "name", label: "Name" },
  { key: "currentValue", label: "Current value (₹)", type: "number", money: true },
  { key: "purchasePrice", label: "Purchase price (₹)", type: "number", money: true },
  { key: "purchaseDate", label: "Purchase date", type: "date" },
  { key: "isRented", label: "Currently rented out", type: "checkbox" },
  { key: "monthlyRentalIncome", label: "Monthly rent (₹)", type: "number", money: true },
  { key: "annualMaintenanceCost", label: "Annual maintenance (₹)", type: "number", money: true },
  { key: "annualPropertyTax", label: "Annual property tax (₹)", type: "number", money: true },
];

export default function PropertyPage() {
  const [summary, setSummary] = useState<PropertyPortfolioSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [type, setType] = useState<PropertyType>("HOUSE");
  const [name, setName] = useState("");
  const [currentValue, setCurrentValue] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [purchaseDate, setPurchaseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isRented, setIsRented] = useState(false);
  const [monthlyRentalIncome, setMonthlyRentalIncome] = useState("");

  const load = () => {
    api.property
      .summary()
      .then(setSummary)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your property portfolio."));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.property.create({
        type,
        name,
        currentValue: parseFloat(currentValue),
        purchasePrice: parseFloat(purchasePrice),
        purchaseDate: new Date(purchaseDate).toISOString(),
        isRented,
        monthlyRentalIncome: isRented && monthlyRentalIncome ? parseFloat(monthlyRentalIncome) : undefined,
      });
      setName("");
      setCurrentValue("");
      setPurchasePrice("");
      setMonthlyRentalIncome("");
      setShowForm(false);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this property.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.property.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.property.update(id, {
      type: values.type as string,
      name: values.name as string,
      currentValue: parseFloat(values.currentValue as string),
      purchasePrice: parseFloat(values.purchasePrice as string),
      purchaseDate: new Date(values.purchaseDate as string).toISOString(),
      isRented: values.isRented as boolean,
      monthlyRentalIncome: values.monthlyRentalIncome ? parseFloat(values.monthlyRentalIncome as string) : undefined,
      annualMaintenanceCost: parseFloat(values.annualMaintenanceCost as string),
      annualPropertyTax: parseFloat(values.annualPropertyTax as string),
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-ink">Property</h1>
          <p className="text-sm text-ink-soft">Houses, land, and rental units — valuation, equity, and yield.</p>
        </div>
        <Button onClick={() => setShowForm((s) => !s)} variant="secondary">
          {showForm ? "Cancel" : "Add property"}
        </Button>
      </div>

      {error && <p className="text-sm text-loss">{error}</p>}

      {summary && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-faint">Total current value</p>
            <p className="money mt-1 text-xl text-ink">{formatINR(summary.totalCurrentValue)}</p>
          </Card>
          <Card>
            <p className="text-xs uppercase tracking-wide text-ink-faint">Total equity</p>
            <p className="money mt-1 text-xl text-ink">{formatINR(summary.totalEquity)}</p>
          </Card>
        </div>
      )}

      {showForm && (
        <Card title="Add a property">
          <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <select value={type} onChange={(e) => setType(e.target.value as PropertyType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {t.charAt(0) + t.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <Input placeholder="Name (e.g. Nandurbar House)" value={name} onChange={(e) => setName(e.target.value)} required />
            <Input type="date" value={purchaseDate} onChange={(e) => setPurchaseDate(e.target.value)} required />
            <Input type="number" min="0" placeholder="Current value (₹)" value={currentValue} onChange={(e) => setCurrentValue(e.target.value)} required className="money" />
            <Input type="number" min="0" placeholder="Purchase price (₹)" value={purchasePrice} onChange={(e) => setPurchasePrice(e.target.value)} required className="money" />
            <label className="flex items-center gap-2 text-sm text-ink-soft">
              <input type="checkbox" checked={isRented} onChange={(e) => setIsRented(e.target.checked)} className="h-4 w-4 accent-marigold-500" />
              Currently rented out
            </label>
            {isRented && (
              <Input type="number" min="0" placeholder="Monthly rent (₹)" value={monthlyRentalIncome} onChange={(e) => setMonthlyRentalIncome(e.target.value)} className="money" />
            )}
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Add property"}
            </Button>
          </form>
        </Card>
      )}

      <Card title="All properties">
        {!summary ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : summary.properties.length === 0 ? (
          <p className="text-sm text-ink-faint">No properties added yet.</p>
        ) : (
          <ul className="space-y-4">
            {summary.properties.map((p) => (
              <li key={p.id} className="ledger-rule pb-4 last:border-b-0 last:pb-0">
                {editingId === p.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      type: p.type,
                      name: p.name,
                      currentValue: p.currentValue,
                      purchasePrice: p.purchasePrice,
                      purchaseDate: p.purchaseDate.slice(0, 10),
                      isRented: p.isRented,
                      monthlyRentalIncome: p.monthlyRentalIncome ?? "",
                      annualMaintenanceCost: p.annualMaintenanceCost,
                      annualPropertyTax: p.annualPropertyTax,
                    }}
                    onSave={(values) => onUpdate(p.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="flex items-start justify-between">
                      <div>
                        <p className="text-sm text-ink">{p.name}</p>
                        <p className="text-xs text-ink-faint">{p.type.toLowerCase()} · purchased {new Date(p.purchaseDate).toLocaleDateString("en-IN")}</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <button onClick={() => setEditingId(p.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                          Edit
                        </button>
                        <button onClick={() => onDelete(p.id)} className="text-xs text-ink-faint hover:text-loss">
                          Remove
                        </button>
                      </div>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                      <div>
                        <p className="text-ink-faint">Current value</p>
                        <p className="money text-ink">{formatINR(p.metrics.currentValue)}</p>
                      </div>
                      <div>
                        <p className="text-ink-faint">Equity</p>
                        <p className="money text-ink">{formatINR(p.metrics.equity)}</p>
                      </div>
                      <div>
                        <p className="text-ink-faint">Appreciation</p>
                        <p className={`money ${p.metrics.appreciationPercent >= 0 ? "text-gain" : "text-loss"}`}>
                          {formatPercent(p.metrics.appreciationPercent)}
                        </p>
                      </div>
                      <div>
                        <p className="text-ink-faint">Rental yield</p>
                        <p className="money text-ink">
                          {p.metrics.rentalYieldPercent !== null ? formatPercent(p.metrics.rentalYieldPercent) : "—"}
                        </p>
                      </div>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
