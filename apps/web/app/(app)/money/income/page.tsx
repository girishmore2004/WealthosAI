"use client";

import { useEffect, useState, FormEvent } from "react";
import type { IncomeDTO, IncomeSource, Recurrence } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const SOURCES: IncomeSource[] = [
  "SALARY",
  "FREELANCE",
  "BUSINESS",
  "RENT",
  "DIVIDEND",
  "INTEREST",
  "BONUS",
  "PENSION",
  "OTHER",
];
const RECURRENCES: Recurrence[] = ["ONE_TIME", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"];

const EDIT_FIELDS: EditField[] = [
  { key: "source", label: "Source", type: "select", options: SOURCES.map((s) => ({ value: s, label: s })) },
  { key: "label", label: "Label" },
  { key: "amount", label: "Amount (₹)", type: "number", money: true },
  { key: "recurrence", label: "Recurrence", type: "select", options: RECURRENCES.map((r) => ({ value: r, label: r })) },
  { key: "receivedAt", label: "Date received", type: "date" },
];

export default function IncomePage() {
  const [items, setItems] = useState<IncomeDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [source, setSource] = useState<IncomeSource>("SALARY");
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("MONTHLY");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.income
      .list()
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load income."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.income.create({
        source,
        label,
        amount: parseFloat(amount),
        recurrence,
        receivedAt: new Date(receivedAt).toISOString(),
      });
      setLabel("");
      setAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this income entry.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.income.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.income.update(id, {
      source: values.source as string,
      label: values.label as string,
      amount: parseFloat(values.amount as string),
      recurrence: values.recurrence as string,
      receivedAt: new Date(values.receivedAt as string).toISOString(),
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Income</h1>
        <p className="text-sm text-ink-soft">Salary, freelance, business, rent, and everything else coming in.</p>
      </div>

      <Card title="Add income">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select
            value={source}
            onChange={(e) => setSource(e.target.value as IncomeSource)}
            className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
          >
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Label (e.g. Monthly salary)" value={label} onChange={(e) => setLabel(e.target.value)} required />
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="Amount (₹)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="money"
          />
          <select
            value={recurrence}
            onChange={(e) => setRecurrence(e.target.value as Recurrence)}
            className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
          >
            {RECURRENCES.map((r) => (
              <option key={r} value={r}>
                {r.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input type="date" value={receivedAt} onChange={(e) => setReceivedAt(e.target.value)} required />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add income"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <Card title="All income">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No income logged yet. Add your first entry above.</p>
        ) : (
          <ul>
            {items.map((item, i) => (
              <li
                key={item.id}
                className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}
              >
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      source: item.source,
                      label: item.label,
                      amount: item.amount,
                      recurrence: item.recurrence,
                      receivedAt: item.receivedAt.slice(0, 10),
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-ink">{item.label}</p>
                      <p className="text-xs text-ink-faint">
                        {item.source.toLowerCase()} · {item.recurrence.toLowerCase()} ·{" "}
                        {new Date(item.receivedAt).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="money text-gain">{formatINR(item.amount)}</span>
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
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
