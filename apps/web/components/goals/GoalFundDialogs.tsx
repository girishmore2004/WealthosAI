"use client";

import { FormEvent, ReactNode, useEffect, useId, useRef, useState } from "react";
import type { CategoryDTO, GoalFundOverviewDTO, GoalFundRulesDTO, GoalFundSummaryDTO, GoalSpendMode } from "@wealthos/types";
import { api, ApiError, EmergencyPlanInput } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { localDateString } from "@/lib/dates";
import { newRequestId } from "@/lib/request-id";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export interface DialogGoal {
  id: string;
  name: string;
  backing: "RESERVE" | "GOAL_LEDGER";
}

/** Tell every page what changed. The emergency reserve also moves real cash, so it keeps its own event. */
function announce(goal: DialogGoal, extra: Array<"expense"> = []) {
  emitFinancialChange("goal");
  if (goal.backing === "RESERVE") emitFinancialChange("emergency");
  extra.forEach((k) => emitFinancialChange(k));
}

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

/** A request id that lives for one user action: reused on a retry, replaced once the action succeeded or the dialog reopens. */
function useRequestId(open: boolean) {
  const ref = useRef<string>(newRequestId());
  useEffect(() => {
    if (open) ref.current = newRequestId();
  }, [open]);
  return { current: () => ref.current, renew: () => (ref.current = newRequestId()) };
}

/** ADD MONEY: set money aside for this goal. It is saved, not spent, so it is never an expense. */
export function AddMoneyDialog({ open, goal, rules, onClose, onSaved }: { open: boolean; goal: DialogGoal; rules: GoalFundRulesDTO; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const rid = useRequestId(open);
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
      await api.goalFunds.add(goal.id, { type: "ALLOCATE", amount: value, occurredAt: date, reason: source.trim() || undefined, notes: notes.trim() || undefined, requestId: rid.current() });
      rid.renew();
      announce(goal);
      onSaved(
        goal.backing === "RESERVE"
          ? `${formatINR(value)} added to your emergency fund. It moved out of your spending cash and is not counted as an expense.`
          : `${formatINR(value)} set aside for ${goal.name}. It is saved, not spent, so it is not counted as an expense.`,
      );
      onClose();
    } catch (err) {
      setError(errText(err, "Could not add this money."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Add money to ${goal.name}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">Money you set aside for this goal. It is saved, not spent, so it never counts as an expense.</p>
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
              {rules.addSources.map((s) => (
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

const MODE_LABEL: Record<GoalSpendMode, { title: string; hint: string }> = {
  EXPENSE: { title: "Counts as an expense", hint: "Everyday spending — it is recorded once in your expenses." },
  OTHER_OUTFLOW: { title: "Not an expense", hint: "For something lasting, like a down payment. Cash leaves, but it is not counted as spending." },
};

/**
 * USE MONEY: take money out of the goal. The withdrawal itself is neither an expense nor income. When the
 * money was actually spent, the spending is recorded once — as an expense or as a non-expense outflow,
 * whichever this kind of goal supports — in the same step.
 */
export function UseMoneyDialog({
  open,
  goal,
  rules,
  onClose,
  balance,
  categories,
  onSaved,
}: {
  open: boolean;
  goal: DialogGoal;
  rules: GoalFundRulesDTO;
  onClose: () => void;
  balance: string | null;
  categories: CategoryDTO[];
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const rid = useRequestId(open);
  const usable = categories.filter((c) => c.type !== "SAVINGS");
  const canSpend = rules.spendModes.length > 0;
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [reason, setReason] = useState("");
  const [notes, setNotes] = useState("");
  const [spent, setSpent] = useState(canSpend);
  const [mode, setMode] = useState<GoalSpendMode>(rules.defaultSpendMode ?? "EXPENSE");
  const [categoryId, setCategoryId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setAmount("");
    setDate(localDateString());
    setReason("");
    setNotes("");
    setSpent(canSpend);
    setMode(rules.defaultSpendMode ?? "EXPENSE");
    setCategoryId((c) => c || usable[0]?.id || "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (balance !== null && value > Number(balance)) return setError(`You can use at most ${formatINR(balance)}, which is what is set aside for this goal.`);
    const recordSpend = canSpend && spent;
    if (recordSpend && !categoryId) return setError("Choose what kind of expense this was.");
    setSubmitting(true);
    setError(null);
    try {
      await api.goalFunds.use(goal.id, {
        amount: value,
        occurredAt: date,
        reason: reason.trim() || undefined,
        notes: notes.trim() || undefined,
        ...(recordSpend ? { spend: { mode, categoryId, merchant: reason.trim() || undefined } } : {}),
        requestId: rid.current(),
      });
      rid.renew();
      announce(goal, recordSpend && mode === "EXPENSE" ? ["expense"] : []);
      onSaved(
        !recordSpend
          ? `${formatINR(value)} taken out of ${goal.name}. Nothing was recorded as spending.`
          : mode === "EXPENSE"
            ? `${formatINR(value)} taken from ${goal.name} and recorded once as an expense. Taking the money out is not itself counted as spending.`
            : `${formatINR(value)} taken from ${goal.name} and recorded as a cash outflow that is not an expense.`,
      );
      onClose();
    } catch (err) {
      setError(errText(err, "Could not use this money."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Use money from ${goal.name}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {balance !== null && (
          <p className="text-sm text-ink-soft">
            {rules.balanceLabel} now: <span className="money text-ink">{formatINR(balance)}</span>. You cannot take out more than this.
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
            <Input id={id("reason")} list={id("reasons")} value={reason} onChange={(e) => setReason(e.target.value)} placeholder={rules.useReasons[0] ?? ""} />
            <datalist id={id("reasons")}>
              {rules.useReasons.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
          <Field id={id("notes")} label="Notes (optional)">
            <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>

        {canSpend ? (
          <div className="rounded-md border border-line bg-surface-muted p-3">
            <label className="flex items-start gap-2 text-sm text-ink">
              <input type="checkbox" checked={spent} onChange={(e) => setSpent(e.target.checked)} className="mt-0.5" />
              <span>
                I spent this money — record it
                <span className="mt-0.5 block text-xs text-ink-faint">The withdrawal is not an expense. What you spent it on is, and it is counted once.</span>
              </span>
            </label>
            {spent && (
              <div className="mt-3 space-y-3">
                {rules.spendModes.length > 1 && (
                  <fieldset>
                    <legend className="mb-1 block text-xs font-medium text-ink-soft">How should it be counted?</legend>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {rules.spendModes.map((m) => (
                        <label key={m} className="cursor-pointer">
                          <input type="radio" name={id("mode")} value={m} checked={mode === m} onChange={() => setMode(m)} className="peer sr-only" />
                          <span className="block rounded-md border border-line px-3 py-2 text-xs text-ink-soft peer-checked:border-marigold-500 peer-checked:bg-marigold-50 peer-checked:text-ink peer-focus-visible:ring-2 peer-focus-visible:ring-marigold-500/40">
                            <span className="block font-medium">{MODE_LABEL[m].title}</span>
                            <span className="block text-ink-faint">{MODE_LABEL[m].hint}</span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
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
        ) : (
          <p className="rounded-md border border-line bg-surface-muted p-3 text-xs text-ink-soft">
            Money in a {rules.typeLabel.toLowerCase()} goal can only be returned to your cash from here. Spend it afterwards through your normal expense and investment flows.
          </p>
        )}

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

/** MOVE MONEY: shift set-aside money from this goal to another. Nothing enters or leaves your cash. */
export function MoveMoneyDialog({
  open,
  goal,
  others,
  balance,
  onClose,
  onSaved,
}: {
  open: boolean;
  goal: DialogGoal;
  others: GoalFundSummaryDTO[];
  balance: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const rid = useRequestId(open);
  const [toGoalId, setToGoalId] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setToGoalId(others[0]?.id ?? "");
    setAmount("");
    setDate(localDateString());
    setNotes("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const value = parseFloat(amount);
    if (!toGoalId) return setError("Choose the goal to move the money to.");
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    if (balance !== null && value > Number(balance)) return setError(`You can move at most ${formatINR(balance)}, which is what is set aside for this goal.`);
    setSubmitting(true);
    setError(null);
    try {
      await api.goalFunds.reallocate(goal.id, { toGoalId, amount: value, occurredAt: date, notes: notes.trim() || undefined, requestId: rid.current() });
      rid.renew();
      const target = others.find((g) => g.id === toGoalId);
      emitFinancialChange("goal");
      // Moving to or from the emergency reserve changes the reserve ledger, which feeds cash and coverage.
      if (goal.backing === "RESERVE" || target?.backing === "RESERVE") emitFinancialChange("emergency");
      onSaved(`${formatINR(value)} moved from ${goal.name} to ${target?.name ?? "the other goal"}. Your cash, income and expenses did not change.`);
      onClose();
    } catch (err) {
      setError(errText(err, "Could not move this money."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={`Move money from ${goal.name}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {others.length === 0 ? (
          <p className="text-sm text-ink-soft">You need another active goal to move money to. Create one first.</p>
        ) : (
          <>
            <p className="text-sm text-ink-soft">
              Shift money you already set aside. It stays yours — it is not income, not an expense, and your net worth does not change.
              {balance !== null && (
                <>
                  {" "}
                  Available to move: <span className="money text-ink">{formatINR(balance)}</span>.
                </>
              )}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={id("to")} label="Move to">
                <select id={id("to")} value={toGoalId} onChange={(e) => setToGoalId(e.target.value)} className={selectClass}>
                  {others.map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field id={id("amount")} label="Amount (₹)">
                <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
              </Field>
              <Field id={id("date")} label="Date">
                <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
              </Field>
              <Field id={id("notes")} label="Notes (optional)">
                <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
              </Field>
            </div>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        {others.length > 0 ? <Actions submitting={submitting} label="Move money" onClose={onClose} /> : <Button type="button" variant="ghost" onClick={onClose}>Close</Button>}
      </form>
    </Modal>
  );
}

type TargetMode = "MONTHS" | "AMOUNT" | "NONE";

/**
 * Set the target and the contribution plan. The emergency reserve may use months of essential expenses; every
 * other goal has a fixed target amount (the server enforces this and the form only offers what is allowed).
 */
export function PlanDialog({ open, goal, rules, overview, onClose, onSaved }: { open: boolean; goal: DialogGoal; rules: GoalFundRulesDTO; overview: GoalFundOverviewDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const months = rules.supportsMonthsTarget;
  const [mode, setMode] = useState<TargetMode>(months ? "MONTHS" : "AMOUNT");
  const [monthsValue, setMonthsValue] = useState("6");
  const [amount, setAmount] = useState("");
  const [monthly, setMonthly] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = overview?.target;
    setMode(months ? (t?.mode ?? "MONTHS") : "AMOUNT");
    setMonthsValue(t?.months ?? "6");
    setAmount(t?.amount && (t.mode === "AMOUNT" || !months) ? t.amount : "");
    setMonthly(overview?.plan.monthlyContribution ?? "");
    setTargetDate(overview?.plan.targetDate && overview.goal.hasTargetDate ? overview.plan.targetDate.slice(0, 10) : "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const body: EmergencyPlanInput = {};
    if (mode === "MONTHS") {
      const m = parseFloat(monthsValue);
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
      await api.goalFunds.setPlan(goal.id, body);
      announce(goal);
      onSaved("Target and plan saved.");
      onClose();
    } catch (err) {
      setError(errText(err, "Could not save the target."));
    } finally {
      setSubmitting(false);
    }
  };

  const choices: Array<[TargetMode, string]> = months
    ? [
        ["MONTHS", "Months of expenses"],
        ["AMOUNT", "A fixed amount"],
        ["NONE", "No target"],
      ]
    : [["AMOUNT", "A fixed amount"]];

  return (
    <Modal open={open} onClose={onClose} title="Target and plan">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        {months && (
          <fieldset>
            <legend className="mb-1 block text-xs font-medium text-ink-soft">My target is…</legend>
            <div className="grid gap-2 sm:grid-cols-3">
              {choices.map(([value, label]) => (
                <label key={value} className="cursor-pointer">
                  <input type="radio" name={id("mode")} value={value} checked={mode === value} onChange={() => setMode(value)} className="peer sr-only" />
                  <span className="block rounded-md border border-line px-2 py-2 text-center text-xs text-ink-soft peer-checked:border-marigold-500 peer-checked:bg-marigold-50 peer-checked:font-medium peer-checked:text-ink peer-focus-visible:ring-2 peer-focus-visible:ring-marigold-500/40">
                    {label}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {mode === "MONTHS" && (
          <Field id={id("months")} label="Months of essential expenses to keep" hint="Worked out from your average essential spending, so the rupee target follows your life.">
            <Input id={id("months")} type="number" inputMode="decimal" min="0.5" max="60" step="0.5" value={monthsValue} onChange={(e) => setMonthsValue(e.target.value)} />
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
        <p className="text-xs text-ink-faint">These are planning inputs. They never change what is actually set aside.</p>

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
