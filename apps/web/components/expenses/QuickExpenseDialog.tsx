"use client";

import { FormEvent, ReactNode, useEffect, useId, useMemo, useState } from "react";
import type { CategoryDTO, ExpensePeriodImpactDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay, localDateString } from "@/lib/dates";
import { PAYMENT_METHOD_OPTIONS } from "@/lib/expense-filters";

// One fast form, several SEPARATE ledgers. What the user is recording decides where it goes, so a
// loan to a friend can never be saved as an expense and an account-to-account transfer can never
// inflate spending. (Investments and emergency-fund money are added on their own pages.)
export type QuickKind = "EXPENSE" | "OTHER_OUTFLOW" | "RECEIVABLE" | "TRANSFER";

const KINDS: Array<{ value: QuickKind; label: string; hint: string }> = [
  { value: "EXPENSE", label: "Expense", hint: "Money spent with nothing coming back: groceries, rent, bills, medical, insurance." },
  { value: "OTHER_OUTFLOW", label: "Other outflow", hint: "Money that genuinely left but isn't everyday spending. It lowers your cash but isn't counted in expense totals." },
  { value: "RECEIVABLE", label: "Money given", hint: "Money you lent and expect back. It is NOT an expense — it is tracked as a receivable until it is returned." },
  { value: "TRANSFER", label: "Transfer", hint: "Moving money between your own accounts. It is not income, spending or investing." },
];

const REPEAT_OPTIONS = [
  { value: "NONE", label: "No" },
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every 2 weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "YEARLY", label: "Yearly" },
];

const LAST_CATEGORY_KEY = "wos.quickExpense.categoryId";

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

function readLastCategory(): string {
  try {
    return window.localStorage.getItem(LAST_CATEGORY_KEY) ?? "";
  } catch {
    return "";
  }
}

interface SavedState {
  kind: QuickKind;
  headline: string;
  detail?: string;
  impact?: ExpensePeriodImpactDTO;
  categoryName?: string;
  date: string;
}

export function QuickExpenseDialog({
  open,
  onClose,
  categories,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  categories: CategoryDTO[];
  onSaved?: (kind: QuickKind) => void;
}) {
  const uid = useId();
  const id = (name: string) => `${uid}-${name}`;

  // Savings-type categories can't hold an expense (the API refuses them), so don't offer them.
  const usable = useMemo(() => categories.filter((c) => c.type !== "SAVINGS"), [categories]);

  const [kind, setKind] = useState<QuickKind>("EXPENSE");
  const [amount, setAmount] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [merchant, setMerchant] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [paymentMethod, setPaymentMethod] = useState("UPI");
  const [notes, setNotes] = useState("");
  const [repeat, setRepeat] = useState("NONE");
  const [repeatEnd, setRepeatEnd] = useState("");
  const [person, setPerson] = useState("");
  const [expectedReturn, setExpectedReturn] = useState("");
  const [fromAccount, setFromAccount] = useState("");
  const [toAccount, setToAccount] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedState | null>(null);

  // Each time the dialog opens: start fresh on today's date, with the last-used category preselected.
  useEffect(() => {
    if (!open) return;
    setDate(localDateString());
    setError(null);
    setSaved(null);
    const last = readLastCategory();
    setCategoryId((current) => current || (usable.some((c) => c.id === last) ? last : (usable[0]?.id ?? "")));
  }, [open, usable]);

  const categoryName = usable.find((c) => c.id === categoryId)?.name ?? "";
  const kindInfo = KINDS.find((k) => k.value === kind)!;
  const isExpenseKind = kind === "EXPENSE" || kind === "OTHER_OUTFLOW";

  const resetForNext = () => {
    setAmount("");
    setMerchant("");
    setNotes("");
    setPerson("");
    setExpectedReturn("");
    setSaved(null);
    setError(null);
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }

    setSubmitting(true);
    try {
      if (isExpenseKind) {
        if (!categoryId) {
          setError("Choose a category.");
          return;
        }
        const result = await api.expenses.quickCreate({
          categoryId,
          amount: value,
          merchant: merchant.trim() || undefined,
          spentAt: date,
          paymentMethod,
          notes: notes.trim() || undefined,
          flowType: kind === "OTHER_OUTFLOW" ? "OTHER_OUTFLOW" : undefined,
          recurrence: repeat !== "NONE" ? repeat : undefined,
          recurrenceEndDate: repeat !== "NONE" && repeatEnd ? repeatEnd : undefined,
        });
        try {
          window.localStorage.setItem(LAST_CATEGORY_KEY, categoryId);
        } catch {
          /* storage unavailable (private mode) — the preselection is a convenience only */
        }
        emitFinancialChange("expense");
        setSaved({
          kind,
          headline: `${kind === "OTHER_OUTFLOW" ? "Outflow" : "Expense"} saved: ${formatINR(value)}${categoryName ? ` · ${categoryName}` : ""}`,
          detail: repeat !== "NONE" ? `Repeats ${repeat.toLowerCase()} — future entries are created automatically when they fall due.` : undefined,
          impact: result.impact,
          categoryName,
          date,
        });
      } else if (kind === "RECEIVABLE") {
        if (!person.trim()) {
          setError("Who did you give the money to?");
          return;
        }
        await api.receivables.create({
          person: person.trim(),
          amount: value,
          givenAt: date,
          purpose: merchant.trim() || undefined,
          expectedReturnAt: expectedReturn || undefined,
          paymentMethod,
          notes: notes.trim() || undefined,
        });
        emitFinancialChange("receivable");
        setSaved({
          kind,
          headline: `${formatINR(value)} given to ${person.trim()}`,
          detail: "Your cash went down, but this is not an expense — it is tracked as a receivable until it is returned.",
          date,
        });
      } else {
        if (!fromAccount.trim() || !toAccount.trim()) {
          setError("Enter both accounts.");
          return;
        }
        await api.transfers.create({ fromAccount: fromAccount.trim(), toAccount: toAccount.trim(), amount: value, transferredAt: date, notes: notes.trim() || undefined });
        emitFinancialChange("transfer");
        setSaved({
          kind,
          headline: `${formatINR(value)} moved from ${fromAccount.trim()} to ${toAccount.trim()}`,
          detail: "Recorded as an internal transfer — it does not change your income, expenses or investments.",
          date,
        });
      }
      onSaved?.(kind);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this entry. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const dayLabel = saved ? (saved.date === localDateString() ? "Today" : formatDay(saved.date)) : "";

  return (
    <Modal open={open} onClose={onClose} title="Quick add">
      {saved ? (
        <div className="space-y-4" role="status">
          <div>
            <p className="font-medium text-ink">{saved.headline}</p>
            {saved.detail && <p className="mt-1 text-sm text-ink-soft">{saved.detail}</p>}
          </div>
          {saved.impact && (
            <dl className="grid grid-cols-3 gap-3 rounded-md border border-line bg-surface-muted p-3 text-sm">
              {[
                { label: dayLabel, value: saved.impact.day.categoryTotal },
                { label: "This month", value: saved.impact.month.categoryTotal },
                { label: "This year", value: saved.impact.year.categoryTotal },
              ].map((row) => (
                <div key={row.label}>
                  <dt className="stat-label">{saved.categoryName ? `${saved.categoryName} · ${row.label}` : row.label}</dt>
                  <dd className="money mt-1 text-ink">{formatINR(row.value)}</dd>
                </div>
              ))}
            </dl>
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={resetForNext}>
              Add another
            </Button>
            <Button type="button" variant="secondary" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <fieldset>
            <legend className="mb-1 block text-xs font-medium text-ink-soft">What are you recording?</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {KINDS.map((k) => (
                <label key={k.value} className="cursor-pointer">
                  <input type="radio" name={id("kind")} value={k.value} checked={kind === k.value} onChange={() => setKind(k.value)} className="peer sr-only" />
                  <span className="block rounded-md border border-line px-2 py-2 text-center text-xs text-ink-soft transition-colors peer-checked:border-marigold-500 peer-checked:bg-marigold-50 peer-checked:font-medium peer-checked:text-ink peer-focus-visible:ring-2 peer-focus-visible:ring-marigold-500/40">
                    {k.label}
                  </span>
                </label>
              ))}
            </div>
            <p className="mt-2 text-xs text-ink-faint">{kindInfo.hint}</p>
          </fieldset>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={id("amount")} label="Amount (₹)">
              <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" placeholder="500" required />
            </Field>

            {isExpenseKind && (
              <Field id={id("category")} label="Category">
                <select id={id("category")} value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={selectClass} required>
                  {usable.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {kind === "RECEIVABLE" && (
              <Field id={id("person")} label="Given to">
                <Input id={id("person")} value={person} onChange={(e) => setPerson(e.target.value)} placeholder="Friend, colleague, business…" required />
              </Field>
            )}

            {kind === "TRANSFER" && (
              <>
                <Field id={id("from")} label="From account">
                  <Input id={id("from")} value={fromAccount} onChange={(e) => setFromAccount(e.target.value)} placeholder="HDFC Savings" required />
                </Field>
                <Field id={id("to")} label="To account">
                  <Input id={id("to")} value={toAccount} onChange={(e) => setToAccount(e.target.value)} placeholder="Paytm Wallet" required />
                </Field>
              </>
            )}

            {kind !== "TRANSFER" && (
              <Field id={id("merchant")} label={kind === "RECEIVABLE" ? "Purpose (optional)" : "Merchant / description"}>
                <Input id={id("merchant")} value={merchant} onChange={(e) => setMerchant(e.target.value)} placeholder={kind === "RECEIVABLE" ? "Short-term loan" : "Big Bazaar"} />
              </Field>
            )}

            <Field id={id("date")} label={kind === "RECEIVABLE" ? "Date given" : "Date"}>
              <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
            </Field>

            {kind !== "TRANSFER" && (
              <Field id={id("pay")} label="Payment method">
                <select id={id("pay")} value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} className={selectClass}>
                  {PAYMENT_METHOD_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {kind === "RECEIVABLE" && (
              <Field id={id("expected")} label="Expected back by (optional)">
                <Input id={id("expected")} type="date" value={expectedReturn} min={date} onChange={(e) => setExpectedReturn(e.target.value)} />
              </Field>
            )}

            {isExpenseKind && (
              <Field id={id("repeat")} label="Repeat?">
                <select id={id("repeat")} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={selectClass}>
                  {REPEAT_OPTIONS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </Field>
            )}

            {isExpenseKind && repeat !== "NONE" && (
              <Field id={id("repeat-end")} label="Stop repeating after (optional)">
                <Input id={id("repeat-end")} type="date" value={repeatEnd} min={date} onChange={(e) => setRepeatEnd(e.target.value)} />
              </Field>
            )}
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
              {submitting ? "Saving…" : kind === "RECEIVABLE" ? "Record money given" : kind === "TRANSFER" ? "Record transfer" : "Save"}
            </Button>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
