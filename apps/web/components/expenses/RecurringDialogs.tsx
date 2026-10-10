"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import type { ExpenseDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { REPEAT_CADENCES, cadenceLabel } from "@/lib/recurrence";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { localDateString } from "@/lib/dates";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

/** Turn a plain expense into a repeating one. A new entry is created automatically each time it falls due — never in advance. */
export function MakeRecurringDialog({ expense, onClose, onSaved }: { expense: ExpenseDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const [cadence, setCadence] = useState("MONTHLY");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const id = expense?.id;
  useEffect(() => {
    if (!id) return;
    setCadence("MONTHLY");
    setEndDate("");
    setError(null);
  }, [id]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!expense) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.expenses.activateRecurrence(expense.id, cadence, endDate || undefined);
      emitFinancialChange("expense");
      onSaved(`Repeating ${cadenceLabel(cadence).toLowerCase()}. New entries are created automatically when they fall due.`);
      onClose();
    } catch (err) {
      setError(errText(err, "Could not start the repeat."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={expense !== null} onClose={onClose} title="Make this repeat">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">
          {expense?.merchant || expense?.category?.name} · <span className="money">{expense ? formatINR(expense.amount) : ""}</span>. You will not need to add it again each period.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-cadence`} className="mb-1 block text-xs font-medium text-ink-soft">
              Repeat
            </label>
            <select id={`${uid}-cadence`} value={cadence} onChange={(e) => setCadence(e.target.value)} className={selectClass}>
              {REPEAT_CADENCES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-end`} className="mb-1 block text-xs font-medium text-ink-soft">
              Stop after (optional)
            </label>
            <Input id={`${uid}-end`} type="date" value={endDate} min={expense?.spentAt.slice(0, 10)} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Start repeating"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Edit HOW the expense repeats from now on. Existing expenses are never changed. */
export function RecurrenceRuleDialog({ expense, onClose, onSaved }: { expense: ExpenseDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [cadence, setCadence] = useState("MONTHLY");
  const [amount, setAmount] = useState("");
  const [endDate, setEndDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The rule values to show: for a generated occurrence the template's values are not on the row, so
  // the dialog starts from this row's values (the user edits what they see; the server resolves the template).
  const eid = expense?.id;
  useEffect(() => {
    if (!expense) return;
    setCadence(expense.recurrence && expense.recurrence !== "ONE_TIME" ? expense.recurrence : "MONTHLY");
    setAmount(expense.recurrenceTemplate?.amount ?? expense.amount);
    setEndDate(expense.recurrenceEndDate ? expense.recurrenceEndDate.slice(0, 10) : "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eid]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!expense) return;
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setSubmitting(true);
    setError(null);
    try {
      await api.expenses.updateRule(expense.id, {
        recurrence: cadence,
        amount: value,
        ...(endDate ? { endDate } : { clearEndDate: true }),
      });
      emitFinancialChange("expense");
      onSaved("Repeat updated. Entries that already exist were not changed.");
      onClose();
    } catch (err) {
      setError(errText(err, "Could not update the repeat."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={expense !== null} onClose={onClose} title="Edit the repeat">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">
          Changes apply to entries created <strong>from now on</strong>. Everything already recorded stays exactly as it is.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id("cadence")} className="mb-1 block text-xs font-medium text-ink-soft">
              Repeat
            </label>
            <select id={id("cadence")} value={cadence} onChange={(e) => setCadence(e.target.value)} className={selectClass}>
              {REPEAT_CADENCES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={id("amount")} className="mb-1 block text-xs font-medium text-ink-soft">
              Amount each time (₹)
            </label>
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" />
          </div>
          <div>
            <label htmlFor={id("end")} className="mb-1 block text-xs font-medium text-ink-soft">
              Stop after (optional)
            </label>
            <Input id={id("end")} type="date" value={endDate} min={localDateString()} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Save repeat"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
