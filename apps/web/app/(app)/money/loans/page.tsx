"use client";

import { useEffect, useState, FormEvent } from "react";
import type { LoanDTO, DebtSummaryDTO, LoanType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const TYPES: LoanType[] = ["HOME", "CAR", "EDUCATION", "PERSONAL", "BUSINESS", "CREDIT_CARD", "FAMILY", "OTHER"];

const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
  { key: "lender", label: "Lender" },
  { key: "principal", label: "Original principal (₹)", type: "number", money: true },
  { key: "outstandingPrincipal", label: "Outstanding principal (₹)", type: "number", money: true },
  { key: "interestRateAnnual", label: "Interest rate (%/yr)", type: "number", money: true },
  { key: "tenureMonths", label: "Tenure (months)", type: "number" },
  { key: "emiAmount", label: "EMI amount (₹)", type: "number", money: true },
  { key: "startDate", label: "Start date", type: "date" },
];

function PrepaymentCalculator({ loan }: { loan: LoanDTO }) {
  const [lumpSum, setLumpSum] = useState("");
  const [result, setResult] = useState<{ monthsSaved: number; interestSaved: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const calculate = async () => {
    if (!lumpSum) return;
    setBusy(true);
    try {
      const res = await api.loans.prepaymentImpact(loan.id, parseFloat(lumpSum));
      setResult(res);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
      <Input
        type="number"
        min="0"
        placeholder="Lump sum (₹)"
        value={lumpSum}
        onChange={(e) => setLumpSum(e.target.value)}
        className="money w-40 py-1 text-xs"
      />
      <Button type="button" variant="secondary" onClick={calculate} disabled={busy} className="px-2 py-1 text-xs">
        {busy ? "Calculating…" : "See prepayment impact"}
      </Button>
      {result && (
        <span className="text-ink-soft">
          Saves <span className="money text-gain">{result.monthsSaved} months</span> and{" "}
          <span className="money text-gain">{formatINR(result.interestSaved)}</span> interest.
        </span>
      )}
    </div>
  );
}

export default function LoansPage() {
  const [items, setItems] = useState<LoanDTO[]>([]);
  const [summary, setSummary] = useState<DebtSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<LoanType>("HOME");
  const [lender, setLender] = useState("");
  const [principal, setPrincipal] = useState("");
  const [outstandingPrincipal, setOutstandingPrincipal] = useState("");
  const [interestRateAnnual, setInterestRateAnnual] = useState("");
  const [tenureMonths, setTenureMonths] = useState("");
  const [emiAmount, setEmiAmount] = useState("");
  const [startDate, setStartDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    Promise.all([api.loans.list(), api.loans.summary()])
      .then(([list, summary]) => {
        setItems(list);
        setSummary(summary);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load loans."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.loans.create({
        type,
        lender,
        principal: parseFloat(principal),
        outstandingPrincipal: parseFloat(outstandingPrincipal),
        interestRateAnnual: parseFloat(interestRateAnnual),
        tenureMonths: parseInt(tenureMonths, 10),
        emiAmount: parseFloat(emiAmount),
        startDate: new Date(startDate).toISOString(),
      });
      setLender("");
      setPrincipal("");
      setOutstandingPrincipal("");
      setInterestRateAnnual("");
      setTenureMonths("");
      setEmiAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this loan.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.loans.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.loans.update(id, {
      type: values.type as string,
      lender: values.lender as string,
      principal: parseFloat(values.principal as string),
      outstandingPrincipal: parseFloat(values.outstandingPrincipal as string),
      interestRateAnnual: parseFloat(values.interestRateAnnual as string),
      tenureMonths: parseInt(values.tenureMonths as string, 10),
      emiAmount: parseFloat(values.emiAmount as string),
      startDate: new Date(values.startDate as string).toISOString(),
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Loans &amp; Debt</h1>
        <p className="text-sm text-ink-soft">Every EMI, tracked against your income.</p>
      </div>

      {summary && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Total outstanding</p>
              <p className="money text-xl text-ink">{formatINR(summary.totalOutstanding)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Monthly EMI</p>
              <p className="money text-xl text-ink">{formatINR(summary.totalMonthlyEmi)}</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Debt stress score</p>
              <p className={`money text-xl ${summary.debtStressScore > 40 ? "text-loss" : "text-gain"}`}>
                {summary.debtStressScore}%
              </p>
            </div>
          </div>
        </Card>
      )}

      <Card title="Add loan">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select value={type} onChange={(e) => setType(e.target.value as LoanType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace("_", " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Lender (e.g. HDFC Bank)" value={lender} onChange={(e) => setLender(e.target.value)} required />
          <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          <Input type="number" min="0" placeholder="Original principal (₹)" value={principal} onChange={(e) => setPrincipal(e.target.value)} required className="money" />
          <Input type="number" min="0" placeholder="Outstanding principal (₹)" value={outstandingPrincipal} onChange={(e) => setOutstandingPrincipal(e.target.value)} required className="money" />
          <Input type="number" min="0" max="50" step="0.1" placeholder="Interest rate (annual %)" value={interestRateAnnual} onChange={(e) => setInterestRateAnnual(e.target.value)} required className="money" />
          <Input type="number" min="1" placeholder="Tenure (months)" value={tenureMonths} onChange={(e) => setTenureMonths(e.target.value)} required />
          <Input type="number" min="0" placeholder="EMI amount (₹)" value={emiAmount} onChange={(e) => setEmiAmount(e.target.value)} required className="money" />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add loan"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <Card title="All loans">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No loans logged yet.</p>
        ) : (
          <ul>
            {items.map((item, i) => (
              <li key={item.id} className={`py-3 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      type: item.type,
                      lender: item.lender,
                      principal: item.principal,
                      outstandingPrincipal: item.outstandingPrincipal,
                      interestRateAnnual: item.interestRateAnnual,
                      tenureMonths: String(item.tenureMonths),
                      emiAmount: item.emiAmount,
                      startDate: item.startDate.slice(0, 10),
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-ink">{item.lender}</p>
                        <p className="text-xs text-ink-faint">
                          {item.type.replace("_", " ").toLowerCase()} · {item.interestRateAnnual}% p.a. · EMI {formatINR(item.emiAmount)}
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="money text-loss">{formatINR(item.outstandingPrincipal)}</span>
                        <button onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                          Edit
                        </button>
                        <button onClick={() => onDelete(item.id)} className="text-xs text-ink-faint hover:text-loss">
                          Remove
                        </button>
                      </div>
                    </div>
                    <PrepaymentCalculator loan={item} />
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
