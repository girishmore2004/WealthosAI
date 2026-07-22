"use client";

import { useEffect, useState, FormEvent } from "react";
import type {
  BusinessDTO,
  BusinessTransactionDTO,
  BusinessObligationDTO,
  BusinessSummaryDTO,
  BusinessTransactionType,
  BusinessEntityType,
  ObligationStatus,
} from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const TXN_TYPES: BusinessTransactionType[] = ["REVENUE", "EXPENSE", "OWNER_DRAWING"];
const ENTITY_TYPES: BusinessEntityType[] = ["SOLE_PROPRIETORSHIP", "PARTNERSHIP", "LLP", "PRIVATE_LIMITED", "OTHER"];
const OBLIGATION_STATUSES: ObligationStatus[] = ["PENDING", "PAID", "OVERDUE", "CANCELLED"];
const RECURRENCES = ["NONE", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"];

const label = (s: string) => s.replace(/_/g, " ").toLowerCase();

export default function BusinessPage() {
  const [businesses, setBusinesses] = useState<BusinessDTO[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState<BusinessSummaryDTO | null>(null);
  const [transactions, setTransactions] = useState<BusinessTransactionDTO[]>([]);
  const [obligations, setObligations] = useState<BusinessObligationDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [dataLoading, setDataLoading] = useState(false);

  const [newBusinessName, setNewBusinessName] = useState("");
  const [txnType, setTxnType] = useState<BusinessTransactionType>("REVENUE");
  const [txnAmount, setTxnAmount] = useState("");
  const [txnDate, setTxnDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [obligationTitle, setObligationTitle] = useState("");
  const [obligationDue, setObligationDue] = useState("");

  // Which record (if any) is currently showing its inline edit form.
  const [editingBusiness, setEditingBusiness] = useState(false);
  const [editingTxnId, setEditingTxnId] = useState<string | null>(null);
  const [editingObligationId, setEditingObligationId] = useState<string | null>(null);

  const selectedBusiness = businesses.find((b) => b.id === selectedId) ?? null;

  const loadBusinesses = () => {
    api.business
      .list()
      .then((list) => {
        setBusinesses(list);
        if (!selectedId && list.length > 0) setSelectedId(list[0].id);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load businesses."))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadBusinesses, []);

  const loadBusinessData = (businessId: string) => {
    setDataLoading(true);
    Promise.all([api.business.summary(businessId), api.business.transactions(businessId), api.business.obligations(businessId)])
      .then(([s, t, o]) => {
        setSummary(s);
        setTransactions(t);
        setObligations(o);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load this business's data."))
      .finally(() => setDataLoading(false));
  };

  useEffect(() => {
    if (selectedId) loadBusinessData(selectedId);
  }, [selectedId]);

  const onCreateBusiness = async (e: FormEvent) => {
    e.preventDefault();
    if (!newBusinessName.trim()) return;
    const created = await api.business.create({ name: newBusinessName });
    setNewBusinessName("");
    setSelectedId(created.id);
    loadBusinesses();
  };

  const onSaveBusiness = async (values: Record<string, string | boolean>) => {
    if (!selectedId) return;
    await api.business.update(selectedId, {
      name: values.name as string,
      description: (values.description as string) || undefined,
      entityType: values.entityType as string,
      currency: (values.currency as string) || undefined,
      startedAt: (values.startedAt as string) || undefined,
      ownershipPercent: values.ownershipPercent ? parseFloat(values.ownershipPercent as string) : undefined,
    });
    setEditingBusiness(false);
    loadBusinesses();
  };

  const onAddTransaction = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId) return;
    try {
      await api.business.createTransaction(selectedId, {
        type: txnType,
        amount: parseFloat(txnAmount),
        occurredAt: new Date(txnDate).toISOString(),
      });
      setTxnAmount("");
      loadBusinessData(selectedId);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this transaction.");
    }
  };

  const onSaveTransaction = async (id: string, values: Record<string, string | boolean>) => {
    await api.business.updateTransaction(id, {
      type: values.type as string,
      category: (values.category as string) || undefined,
      amount: parseFloat(values.amount as string),
      occurredAt: new Date(values.occurredAt as string).toISOString(),
      description: (values.description as string) || undefined,
      isRecurring: values.isRecurring as boolean,
    });
    setEditingTxnId(null);
    if (selectedId) loadBusinessData(selectedId);
  };

  const onDeleteTransaction = async (id: string) => {
    await api.business.removeTransaction(id);
    if (selectedId) loadBusinessData(selectedId);
  };

  const onAddObligation = async (e: FormEvent) => {
    e.preventDefault();
    if (!selectedId || !obligationTitle.trim() || !obligationDue) return;
    await api.business.createObligation(selectedId, { title: obligationTitle, dueDate: new Date(obligationDue).toISOString() });
    setObligationTitle("");
    setObligationDue("");
    loadBusinessData(selectedId);
  };

  const onSaveObligation = async (id: string, values: Record<string, string | boolean>) => {
    await api.business.updateObligation(id, {
      title: values.title as string,
      dueDate: new Date(values.dueDate as string).toISOString(),
      amount: values.amount ? parseFloat(values.amount as string) : undefined,
      recurrence: values.recurrence as string,
      vendor: (values.vendor as string) || undefined,
      status: values.status as string,
      notes: (values.notes as string) || undefined,
    });
    setEditingObligationId(null);
    if (selectedId) loadBusinessData(selectedId);
  };

  const onDeleteObligation = async (id: string) => {
    await api.business.removeObligation(id);
    if (selectedId) loadBusinessData(selectedId);
  };

  const businessFields: EditField[] = [
    { key: "name", label: "Business name" },
    { key: "description", label: "Description" },
    { key: "entityType", label: "Entity type", type: "select", options: ENTITY_TYPES.map((t) => ({ value: t, label: label(t) })) },
    { key: "currency", label: "Currency (e.g. INR)" },
    { key: "startedAt", label: "Started on", type: "date" },
    { key: "ownershipPercent", label: "Your ownership %", type: "number" },
  ];

  const transactionFields: EditField[] = [
    { key: "type", label: "Type", type: "select", options: TXN_TYPES.map((t) => ({ value: t, label: label(t) })) },
    { key: "category", label: "Category" },
    { key: "amount", label: "Amount (₹)", type: "number", money: true },
    { key: "occurredAt", label: "Date", type: "date" },
    { key: "description", label: "Memo" },
    { key: "isRecurring", label: "Recurring", type: "checkbox" },
  ];

  const obligationFields: EditField[] = [
    { key: "title", label: "Title" },
    { key: "dueDate", label: "Due date", type: "date" },
    { key: "amount", label: "Amount (₹)", type: "number", money: true },
    { key: "recurrence", label: "Recurrence", type: "select", options: RECURRENCES.map((r) => ({ value: r, label: label(r) })) },
    { key: "vendor", label: "Vendor" },
    { key: "status", label: "Status", type: "select", options: OBLIGATION_STATUSES.map((s) => ({ value: s, label: label(s) })) },
    { key: "notes", label: "Notes" },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Business</h1>
        <p className="text-sm text-ink-soft">Revenue, expenses, profit, and key dates for your business.</p>
      </div>

      {error && <p className="text-sm text-loss">{error}</p>}

      <Card title="Your businesses">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading your businesses…</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {businesses.map((b) => (
              <button
                key={b.id}
                onClick={() => {
                  setSelectedId(b.id);
                  setEditingBusiness(false);
                }}
                className={`rounded-sm border px-3 py-1.5 text-sm ${
                  selectedId === b.id ? "border-marigold-500 text-marigold-600" : "border-line text-ink-soft"
                }`}
              >
                {b.name}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={onCreateBusiness} className="mt-3 flex gap-2">
          <Input placeholder="New business name" value={newBusinessName} onChange={(e) => setNewBusinessName(e.target.value)} />
          <Button type="submit" variant="secondary">
            Add
          </Button>
        </form>
      </Card>

      {selectedId && selectedBusiness && summary && (
        <>
          <Card
            title={selectedBusiness.name}
            eyebrow={`${label(selectedBusiness.entityType)} · ${selectedBusiness.currency}`}
            action={
              !editingBusiness && (
                <Button variant="secondary" onClick={() => setEditingBusiness(true)}>
                  Edit
                </Button>
              )
            }
          >
            {editingBusiness ? (
              <InlineEditForm
                fields={businessFields}
                initialValues={{
                  name: selectedBusiness.name,
                  description: selectedBusiness.description ?? "",
                  entityType: selectedBusiness.entityType,
                  currency: selectedBusiness.currency,
                  startedAt: selectedBusiness.startedAt ? selectedBusiness.startedAt.slice(0, 10) : "",
                  ownershipPercent: selectedBusiness.ownershipPercent ?? "",
                }}
                onSave={onSaveBusiness}
                onCancel={() => setEditingBusiness(false)}
              />
            ) : (
              <dl className="grid gap-2 text-sm sm:grid-cols-2">
                {selectedBusiness.description && (
                  <div>
                    <dt className="text-ink-faint">Description</dt>
                    <dd className="text-ink">{selectedBusiness.description}</dd>
                  </div>
                )}
                {selectedBusiness.startedAt && (
                  <div>
                    <dt className="text-ink-faint">Started</dt>
                    <dd className="text-ink">{new Date(selectedBusiness.startedAt).toLocaleDateString("en-IN")}</dd>
                  </div>
                )}
                {selectedBusiness.ownershipPercent && (
                  <div>
                    <dt className="text-ink-faint">Your ownership</dt>
                    <dd className="text-ink">{selectedBusiness.ownershipPercent}%</dd>
                  </div>
                )}
              </dl>
            )}
          </Card>

          <div className="grid gap-4 sm:grid-cols-3">
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Revenue ({summary.month})</p>
              <p className="money mt-1 text-xl text-gain">{formatINR(summary.revenue)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Expenses</p>
              <p className="money mt-1 text-xl text-loss">{formatINR(summary.expenses)}</p>
            </Card>
            <Card>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Profit</p>
              <p className="money mt-1 text-xl text-ink">{formatINR(summary.profit)}</p>
            </Card>
          </div>

          <Card title="6-month trend">
            <ul>
              {summary.trend.map((t, i) => (
                <li key={t.month} className={`flex justify-between py-1.5 text-sm ${i !== summary.trend.length - 1 ? "ledger-rule" : ""}`}>
                  <span className="text-ink-soft">{t.month}</span>
                  <span className="money text-ink">{formatINR(t.profit)} profit</span>
                </li>
              ))}
            </ul>
          </Card>

          <Card title="Log a transaction">
            <form onSubmit={onAddTransaction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <select value={txnType} onChange={(e) => setTxnType(e.target.value as BusinessTransactionType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
                {TXN_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {label(t)}
                  </option>
                ))}
              </select>
              <Input type="number" min="0" placeholder="Amount (₹)" value={txnAmount} onChange={(e) => setTxnAmount(e.target.value)} required className="money" />
              <Input type="date" value={txnDate} onChange={(e) => setTxnDate(e.target.value)} required />
              <Button type="submit">Add</Button>
            </form>
          </Card>

          <Card title="Recent transactions">
            {dataLoading ? (
              <p className="text-sm text-ink-faint">Loading transactions…</p>
            ) : transactions.length === 0 ? (
              <p className="text-sm text-ink-faint">No transactions logged yet.</p>
            ) : (
              <ul className="space-y-2">
                {transactions.slice(0, 10).map((t) =>
                  editingTxnId === t.id ? (
                    <li key={t.id}>
                      <InlineEditForm
                        fields={transactionFields}
                        initialValues={{
                          type: t.type,
                          category: t.category ?? "",
                          amount: t.amount,
                          occurredAt: t.occurredAt.slice(0, 10),
                          description: t.description ?? "",
                          isRecurring: t.isRecurring,
                        }}
                        onSave={(values) => onSaveTransaction(t.id, values)}
                        onCancel={() => setEditingTxnId(null)}
                      />
                    </li>
                  ) : (
                    <li key={t.id} className="flex items-center justify-between py-1.5 text-sm ledger-rule">
                      <span className="text-ink-soft">
                        {label(t.type)} · {new Date(t.occurredAt).toLocaleDateString("en-IN")}
                        {t.description ? ` · ${t.description}` : ""}
                      </span>
                      <span className="flex items-center gap-3">
                        <span className={`money ${t.type === "REVENUE" ? "text-gain" : "text-loss"}`}>{formatINR(t.amount)}</span>
                        <button onClick={() => setEditingTxnId(t.id)} className="text-xs text-marigold-600 hover:underline">
                          Edit
                        </button>
                        <button onClick={() => onDeleteTransaction(t.id)} className="text-xs text-loss hover:underline">
                          Delete
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Card>

          <Card title="Upcoming obligations (GST, tax filing, etc.)">
            <form onSubmit={onAddObligation} className="mb-3 grid gap-2 sm:grid-cols-3">
              <Input placeholder="Title (e.g. GST filing)" value={obligationTitle} onChange={(e) => setObligationTitle(e.target.value)} />
              <Input type="date" value={obligationDue} onChange={(e) => setObligationDue(e.target.value)} />
              <Button type="submit" variant="secondary">
                Add
              </Button>
            </form>
            {dataLoading ? (
              <p className="text-sm text-ink-faint">Loading obligations…</p>
            ) : obligations.length === 0 ? (
              <p className="text-sm text-ink-faint">No obligations tracked yet.</p>
            ) : (
              <ul className="space-y-2">
                {obligations.map((o) =>
                  editingObligationId === o.id ? (
                    <li key={o.id}>
                      <InlineEditForm
                        fields={obligationFields}
                        initialValues={{
                          title: o.title,
                          dueDate: o.dueDate.slice(0, 10),
                          amount: o.amount ?? "",
                          recurrence: o.recurrence,
                          vendor: o.vendor ?? "",
                          status: o.status,
                          notes: o.notes ?? "",
                        }}
                        onSave={(values) => onSaveObligation(o.id, values)}
                        onCancel={() => setEditingObligationId(null)}
                      />
                    </li>
                  ) : (
                    <li key={o.id} className="flex items-center justify-between py-1.5 text-sm ledger-rule">
                      <span className="text-ink">
                        {o.title}
                        {o.vendor ? ` · ${o.vendor}` : ""}
                        <span
                          className={`ml-2 rounded-sm px-1.5 py-0.5 text-[11px] uppercase tracking-wide ${
                            o.status === "PAID"
                              ? "bg-gain/10 text-gain"
                              : o.status === "OVERDUE"
                                ? "bg-loss/10 text-loss"
                                : o.status === "CANCELLED"
                                  ? "bg-ink-faint/10 text-ink-faint"
                                  : "bg-marigold-500/10 text-marigold-600"
                          }`}
                        >
                          {label(o.status)}
                        </span>
                      </span>
                      <span className="flex items-center gap-3">
                        <span className="text-ink-faint">{new Date(o.dueDate).toLocaleDateString("en-IN")}</span>
                        <button onClick={() => setEditingObligationId(o.id)} className="text-xs text-marigold-600 hover:underline">
                          Edit
                        </button>
                        <button onClick={() => onDeleteObligation(o.id)} className="text-xs text-loss hover:underline">
                          Delete
                        </button>
                      </span>
                    </li>
                  ),
                )}
              </ul>
            )}
          </Card>
        </>
      )}

      {!loading && businesses.length === 0 && <p className="text-sm text-ink-faint">Add a business above to start tracking it.</p>}

      <p className="text-[11px] text-ink-faint">
        Business profit shown here is separate from your personal Income — log your own salary or drawings under
        Money → Income if you want them reflected in your personal dashboard and tax estimate.
      </p>
    </div>
  );
}
