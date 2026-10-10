"use client";

import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import type { CategoryDTO, EmergencyFundOverviewDTO } from "@wealthos/types";
import { api, ApiError, EmergencyPlanInput } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { localDateString } from "@/lib/dates";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export const ADD_SOURCES = ["Monthly contribution", "Bonus", "Extra savings", "Salary allocation"];
export const USE_REASONS = ["Medical emergency", "Job loss", "Urgent repair", "Family emergency"];

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-soft">
        {label}
      </label>
      {children}
      {hint && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}

function Actions({ submitting, label, onClose }: { submitting: boolean; label: string; onClose: () => void }) {
  return (
    <div className="flex gap-2">
      <Button type="submit" disabled={submitting}>
        {submitting ? "Saving…" : label}
      </Button>
      <Button type="button" variant="ghost" onClick={onClose}>
        Cancel
      </Button>
    </div>
  );
}

/** ADD MONEY: move money into the reserve. It is saved for emergencies, not spent, so it is never an expense. */
export function AddMoneyDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [source, setSource] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setDate(localDateString());
    setSource("");
    setNotes("");
    setError(null);
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setSubmitting(true);
    setError(null);
    try {
      await api.emergencyFund.create({ type: "ALLOCATE", amount: value, occurredAt: date, reason: source.trim() || undefined, notes: notes.trim() || undefined });
      emitFinancialChange("emergency");
      onSaved(`${formatINR(value)} added to your emergency fund. It moved out of your spending cash and is not counted as an expense.`);
      onClose();
    } catch (err) {
      setError(errText(err, "Could not add this money."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add money to your emergency fund">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">Money you set aside for emergencies. It is saved, not spent, so it never counts as an expense.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("amount")} label="Amount (₹)">
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
          </Field>
          <Field id={id("date")} label="Date">
            <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field id={id("source")} label="Source (optional)">
            <Input id={id("source")} list={id("sources")} value={source} onChange={(e) => setSource(e.target.value)} placeholder="Monthly contribution" />
            <datalist id={id("sources")}>
              {ADD_SOURCES.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
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
        <Actions submitting={submitting} label="Add money" onClose={onClose} />
      </form>
    </Modal>
  );
}

/**
 * USE MONEY: take money out of the reserve. The withdrawal itself is neither an expense nor income. When
 * the money was actually spent, the spending is recorded once as a genuine expense — in the same step.
 */
export function UseMoneyDialog({
  open,
  onClose,
  balance,
  categories,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  balance: string | null;
  categories: CategoryDTO[];
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const usable = categories.filter((c) => c.type !== "SAVINGS");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [spent, setSpent] = useState(true);
  const [categoryId, setCategoryId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setDate(localDateString());
    setReason("");
    setNotes("");
    setSpent(true);
    setCategoryId((c) => c || usable[0]?.id || "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (balance !== null && value > Number(balance)) return setError(`You can use at most ${formatINR(balance)}, which is what is in the fund.`);
    if (spent && !categoryId) return setError("Choose what kind of expense this was.");
    setSubmitting(true);
    setError(null);
    try {
      await api.emergencyFund.use({
        amount: value,
        occurredAt: date,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        ...(spent ? { expense: { categoryId, merchant: reason.trim() || undefined } } : {}),
      });
      emitFinancialChange("emergency");
      if (spent) emitFinancialChange("expense");
      onSaved(
        spent
          ? `${formatINR(value)} taken from your emergency fund and recorded once as an expense. Taking the money out is not itself counted as spending.`
          : `${formatINR(value)} taken out of your emergency fund. Nothing was recorded as spending.`,
      );
      onClose();
    } catch (err) {
      setError(errText(err, "Could not use this money."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Use money from your emergency fund">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {balance !== null && (
          <p className="text-sm text-ink-soft">
            In the fund now: <span className="money text-ink">{formatINR(balance)}</span>. You cannot take out more than this.
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("amount")} label="Amount (₹)">
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
          </Field>
          <Field id={id("date")} label="Date">
            <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field id={id("reason")} label="Reason (optional)">
            <Input id={id("reason")} list={id("reasons")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Medical emergency" />
            <datalist id={id("reasons")}>
              {USE_REASONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <Field id={id("notes")} label="Notes (optional)">
            <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        <div className="rounded-md border border-line bg-surface-muted p-3">
          <label className="flex items-start gap-2 text-sm text-ink">
            <input type="checkbox" checked={spent} onChange={(e) => setSpent(e.target.checked)} className="mt-0.5" />
            <span>
              I spent this money — record it as an expense
              <span className="mt-0.5 block text-xs text-ink-faint">The withdrawal is not an expense. What you spent it on is, and it is counted once.</span>
            </span>
          </label>
          {spent && (
            <div className="mt-3">
              <Field id={id("category")} label="What was it for?">
                <select id={id("category")} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectClass}>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          )}
        </div>

        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Use money" onClose={onClose} />
      </form>
    </Modal>
  );
}

type TargetMode = "MONTHS" | "AMOUNT" | "NONE";

/** Set the target (months of essential expenses OR a fixed amount) and the contribution plan. */
export function PlanDialog({ open, overview, onClose, onSaved }: { open: boolean; overview: EmergencyFundOverviewDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [mode, setMode] = useState<TargetMode>("MONTHS");
  const [months, setMonths] = useState("6");
  const [amount, setAmount] = useState("");
  const [monthly, setMonthly] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = overview?.target;
    setMode(t?.mode ?? "MONTHS");
    setMonths(t?.months ?? "6");
    setAmount(t?.mode === "AMOUNT" && t.amount ? t.amount : "");
    setMonthly(overview?.plan.monthlyContribution ?? "");
    setTargetDate(overview?.plan.targetDate ? overview.plan.targetDate.slice(0, 10) : "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const body: EmergencyPlanInput = {};
    if (mode === "MONTHS") {
      const m = parseFloat(months);
      if (!Number.isFinite(m) || m < 0.5 || m > 60) return setError("Choose between 0.5 and 60 months.");
      body.targetMonths = m;
    } else if (mode === "AMOUNT") {
      const a = parseFloat(amount);
      if (!Number.isFinite(a) || a <= 0) return setError("Enter a target amount greater than zero.");
      body.targetAmount = a;
    } else {
      body.targetAmount = null;
      body.targetMonths = null;
    }

    if (monthly.trim() === "") body.monthlyContribution = null;
    else {
      const c = parseFloat(monthly);
      if (!Number.isFinite(c) || c <= 0) return setError("Enter a monthly contribution greater than zero, or leave it empty.");
      body.monthlyContribution = c;
    }
    if (targetDate) {
      if (targetDate < localDateString()) return setError("The target date cannot be in the past.");
      body.targetDate = targetDate;
    } else body.targetDate = null;

    setSubmitting(true);
    setError(null);
    try {
      await api.emergencyFund.setPlan(body);
      emitFinancialChange("emergency");
      onSaved("Target and plan saved.");
      onClose();
    } catch (err) {
      setError(errText(err, "Could not save the target."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Target and plan">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <fieldset>
          <legend className="mb-1 block text-xs font-medium text-ink-soft">My target is…</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ["MONTHS", "Months of expenses"],
                ["AMOUNT", "A fixed amount"],
                ["NONE", "No target"],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="cursor-pointer">
                <input type="radio" name={id("mode")} value={value} checked={mode === value} onChange={() => setMode(value)} className="peer sr-only" />
                <span className="block rounded-md border border-line px-2 py-2 text-center text-xs text-ink-soft peer-checked:border-marigold-500 peer-checked:bg-marigold-50 peer-checked:font-medium peer-checked:text-ink peer-focus-visible:ring-2 peer-focus-visible:ring-marigold-500/40">
                  {label}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {mode === "MONTHS" && (
          <Field id={id("months")} label="Months of essential expenses to keep" hint="Worked out from your average essential spending, so the rupee target follows your life.">
            <Input id={id("months")} type="number" inputMode="decimal" min="0.5" max="60" step="0.5" value={months} onChange={(e) => setMonths(e.target.value)} />
          </Field>
        )}
        {mode === "AMOUNT" && (
          <Field id={id("amount")} label="Target amount (₹)">
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" />
          </Field>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("monthly")} label="I plan to add each month (₹, optional)">
            <Input id={id("monthly")} type="number" inputMode="decimal" min="0" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)} className="money" />
          </Field>
          <Field id={id("date")} label="Reach the target by (optional)">
            <Input id={id("date")} type="date" value={targetDate} min={localDateString()} onChange={(e) => setTargetDate(e.target.value)} />
          </Field>
        </div>
        <p className="text-xs text-ink-faint">These are planning inputs. They never change what is actually in the fund.</p>

        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Save" onClose={onClose} />
      </form>
    </Modal>
  );
}
