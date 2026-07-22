"use client";

import { useEffect, useState, FormEvent } from "react";
import type { ExpenseDTO, CategoryDTO, PaymentMethod } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { ExpenseBreakdownChart } from "@/components/expenses/ExpenseBreakdownChart";
import { formatINR } from "@/lib/format";

const PAYMENT_METHODS: PaymentMethod[] = ["UPI", "CARD", "CASH", "BANK_TRANSFER", "WALLET", "OTHER"];

export default function ExpensesPage() {
  const [items, setItems] = useState<ExpenseDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState("");
  const [merchant, setMerchant] = useState("");
  const [amount, setAmount] = useState("");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("UPI");
  const [spentAt, setSpentAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const load = () => {
    setLoading(true);
    setRefreshKey((k) => k + 1);
    Promise.all([api.expenses.list(), api.expenses.categories()])
      .then(([expenses, cats]) => {
        setItems(expenses);
        setCategories(cats);
        if (!categoryId && cats.length > 0) setCategoryId(cats[0].id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load expenses."))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.expenses.create({
        categoryId,
        merchant: merchant || undefined,
        amount: parseFloat(amount),
        spentAt: new Date(spentAt).toISOString(),
        paymentMethod,
      });
      setMerchant("");
      setAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this expense.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.expenses.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.expenses.update(id, {
      categoryId: values.categoryId as string,
      merchant: (values.merchant as string) || undefined,
      amount: parseFloat(values.amount as string),
      spentAt: new Date(values.spentAt as string).toISOString(),
      paymentMethod: values.paymentMethod as string,
    });
    setEditingId(null);
    load();
  };

  const editFields: EditField[] = [
    { key: "categoryId", label: "Category", type: "select", options: categories.map((c) => ({ value: c.id, label: c.name })) },
    { key: "merchant", label: "Merchant" },
    { key: "amount", label: "Amount (₹)", type: "number", money: true },
    { key: "paymentMethod", label: "Payment method", type: "select", options: PAYMENT_METHODS.map((m) => ({ value: m, label: m })) },
    { key: "spentAt", label: "Date spent", type: "date" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Expenses</h1>
        <p className="text-sm text-ink-soft">Every rupee spent, categorized.</p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Add expense">
          <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2">
            <select
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
              required
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <Input placeholder="Merchant (optional)" value={merchant} onChange={(e) => setMerchant(e.target.value)} />
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
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  {m.replace("_", " ").toLowerCase()}
                </option>
              ))}
            </select>
            <Input type="date" value={spentAt} onChange={(e) => setSpentAt(e.target.value)} required />
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : "Add expense"}
            </Button>
          </form>
          {error && <p className="mt-2 text-sm text-loss">{error}</p>}
        </Card>

        <ExpenseBreakdownChart refreshKey={refreshKey} />
      </div>

      <Card title="All expenses">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No expenses logged yet. Add your first entry above.</p>
        ) : (
          <ul>
            {items.map((item, i) => (
              <li key={item.id} className={`py-2 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={editFields}
                    initialValues={{
                      categoryId: item.categoryId,
                      merchant: item.merchant ?? "",
                      amount: item.amount,
                      paymentMethod: item.paymentMethod,
                      spentAt: item.spentAt.slice(0, 10),
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-ink">{item.merchant || item.category?.name}</p>
                      <p className="text-xs text-ink-faint">
                        {item.category?.name} · {item.paymentMethod.toLowerCase()} ·{" "}
                        {new Date(item.spentAt).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="money text-loss">-{formatINR(item.amount)}</span>
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
