"use client";

import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import type { ReceivableDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { localDateString } from "@/lib/dates";
import { PAYMENT_METHOD_OPTIONS } from "@/lib/expense-filters";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";

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

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

// A key that is generated ONCE per opening of the dialog: a double-click or a retry after a flaky
// network re-sends the same key, and the server records a single repayment.
function newIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `rp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Add a receivable, or edit an existing one (pass `editing`). */
export function ReceivableFormDialog({
  open,
  onClose,
  editing,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  editing?: ReceivableDTO | null;
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [person, setPerson] = useState("");
  const [amount, setAmount] = useState("");
  const [givenAt, setGivenAt] = useState(() => localDateString());
  const [expected, setExpected] = useState("");
  const [purpose, setPurpose] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setPerson(editing?.person ?? "");
    setAmount(editing ? editing.originalAmount : "");
    setGivenAt(editing ? editing.givenAt.slice(0, 10) : localDateString());
    setExpected(editing?.expectedReturnAt ? editing.expectedReturnAt.slice(0, 10) : "");
    setPurpose(editing?.purpose ?? "");
    setPaymentMethod(editing?.paymentMethod ?? "UPI");
    setNotes(editing?.notes ?? "");
  }, [open, editing]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = parseFloat(amount);
    if (!person.trim()) return setError("Who did you give the money to?");
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");

    setSubmitting(true);
    try {
      const body = {
        person: person.trim(),
        amount: value,
        givenAt,
        purpose: purpose.trim() || undefined,
        expectedReturnAt: expected || undefined,
        paymentMethod,
        notes: notes.trim() || undefined,
      };
      if (editing) await api.receivables.update(editing.id, body);
      else await api.receivables.create(body);
      emitFinancialChange("receivable");
      onSaved(editing ? "Receivable updated." : `${formatINR(value)} recorded as given to ${person.trim()} — not counted as an expense.`);
      onClose();
    } catch (err) {
      setError(errText(err, "Could not save this receivable."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={editing ? "Edit receivable" : "Money given"}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {!editing && (
          <p className="text-xs text-ink-faint">
            Money you lent and expect back. Your cash goes down, but it is <strong>not</strong> an expense — it is tracked here until it is returned.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("person")} label="Given to">
            <Input id={id("person")} value={person} onChange={(e) => setPerson(e.target.value)} required />
          </Field>
          <Field id={id("amount")} label="Amount (₹)">
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
          </Field>
          <Field id={id("given")} label="Date given">
            <Input id={id("given")} type="date" value={givenAt} onChange={(e) => setGivenAt(e.target.value)} required />
          </Field>
          <Field id={id("expected")} label="Expected back by (optional)">
            <Input id={id("expected")} type="date" value={expected} min={givenAt} onChange={(e) => setExpected(e.target.value)} />
          </Field>
          <Field id={id("purpose")} label="Purpose (optional)">
            <Input id={id("purpose")} value={purpose} onChange={(e) => setPurpose(e.target.value)} />
          </Field>
          <Field id={id("pay")} label="Payment method">
            <select id={id("pay")} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>
              {PAYMENT_METHOD_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Field id={id("notes")} label="Notes (optional)">
          <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : editing ? "Save changes" : "Record money given"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Record that some (or all) of the money came back. Cash goes up; the receivable goes down; income is untouched. */
export function RepaymentDialog({
  receivable,
  onClose,
  onSaved,
}: {
  receivable: ReceivableDTO | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [amount, setAmount] = useState("");
  const [returnedAt, setReturnedAt] = useState(() => localDateString());
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [notes, setNotes] = useState("");
  const [key, setKey] = useState(newIdempotencyKey);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rid = receivable?.id;
  useEffect(() => {
    if (!rid) return;
    setAmount("");
    setReturnedAt(localDateString());
    setNotes("");
    setError(null);
    setKey(newIdempotencyKey());
  }, [rid]);

  if (!receivable) return <Modal open={false} onClose={onClose} title="Record a return">{null}</Modal>;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");

    setSubmitting(true);
    try {
      const res = await api.receivables.recordRepayment(receivable.id, {
        amount: value,
        returnedAt,
        paymentMethod,
        notes: notes.trim() || undefined,
        idempotencyKey: key,
      });
      emitFinancialChange("receivable");
      const left = res.receivable.outstandingAmount;
      onSaved(
        res.duplicate
          ? "That repayment was already recorded."
          : res.receivable.status === "FULLY_RETURNED"
            ? `Repayment recorded. ${receivable.person} has returned everything.`
            : `Repayment recorded. ${formatINR(left)} still outstanding from ${receivable.person}.`,
      );
      onClose();
    } catch (err) {
      setError(errText(err, "Could not record this repayment."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={`Record a return from ${receivable.person}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">
          Outstanding: <span className="money text-ink">{formatINR(receivable.outstandingAmount)}</span> of {formatINR(receivable.originalAmount)}. A return brings cash back — it is not income.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("amount")} label="Amount returned (₹)">
            <div className="flex gap-2">
              <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
              <Button type="button" variant="secondary" size="sm" onClick={() => setAmount(receivable.outstandingAmount)}>
                Full
              </Button>
            </div>
          </Field>
          <Field id={id("date")} label="Date returned">
            <Input id={id("date")} type="date" value={returnedAt} min={receivable.givenAt.slice(0, 10)} onChange={(e) => setReturnedAt(e.target.value)} required />
          </Field>
          <Field id={id("pay")} label="Payment method">
            <select id={id("pay")} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>
              {PAYMENT_METHOD_OPTIONS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id={id("notes")} label="Notes (optional)">
            <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Recording…" : "Record return"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
