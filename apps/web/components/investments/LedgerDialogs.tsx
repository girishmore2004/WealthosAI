"use client";

import { FormEvent, ReactNode, useEffect, useId, useState } from "react";
import type { InvestmentCashflowType, InvestmentDTO, SipScheduleSummaryDTO } from "@wealthos/types";
import { api, ApiError, SipScheduleInput } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { localDateString } from "@/lib/dates";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

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

// What each ledger entry type means for the holding — shown beside the choice so nobody has to guess.
export const CASHFLOW_TYPES: Array<{ value: InvestmentCashflowType; label: string; hint: string; employerOnly?: boolean }> = [
  { value: "CONTRIBUTION", label: "Contribution", hint: "Money you put in. Not an expense — it is moved from your cash into this investment." },
  { value: "WITHDRAWAL", label: "Withdrawal", hint: "Money you took out. It comes back to your cash." },
  { value: "DIVIDEND", label: "Dividend", hint: "Income paid out to you in cash." },
  { value: "FEE", label: "Fee", hint: "A genuine cost, such as a management or brokerage fee." },
  { value: "EMPLOYER_CONTRIBUTION", label: "Employer contribution", hint: "Added by your employer (EPF / NPS). It raises the asset but is not your own cash.", employerOnly: true },
  { value: "INTEREST", label: "Interest credited", hint: "Growth already inside the value (it is not new money from you)." },
  { value: "TRANSFER_IN", label: "Transferred in", hint: "Moved in from another holding." },
  { value: "TRANSFER_OUT", label: "Transferred out", hint: "Moved out to another holding." },
];
const EMPLOYER_TYPES = new Set(["EPF", "NPS"]);

/** Record a contribution, withdrawal, dividend, fee … on one holding's ledger. */
export function CashflowDialog({ investment, onClose, onSaved }: { investment: InvestmentDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [type, setType] = useState<InvestmentCashflowType>("CONTRIBUTION");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iid = investment?.id;
  useEffect(() => {
    if (!iid) return;
    setType("CONTRIBUTION");
    setAmount("");
    setDate(localDateString());
    setNotes("");
    setError(null);
  }, [iid]);

  const options = CASHFLOW_TYPES.filter((t) => !t.employerOnly || (investment && EMPLOYER_TYPES.has(investment.type)));
  const info = CASHFLOW_TYPES.find((t) => t.value === type);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!investment) return;
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter an amount greater than zero.");
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.addCashflow(investment.id, { type, amount: value, occurredAt: date, notes: notes.trim() || undefined });
      emitFinancialChange("investment");
      onSaved(type === "CONTRIBUTION" ? `Contribution of ${formatINR(value)} recorded. It is not counted as an expense.` : "Entry recorded.");
      onClose();
    } catch (err) {
      setError(errText(err, "Could not record this entry."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={investment !== null} onClose={onClose} title={`Add a transaction${investment ? ` · ${investment.name}` : ""}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("type")} label="What happened" hint={info?.hint}>
            <select id={id("type")} value={type} onChange={(e) => setType(e.target.value as InvestmentCashflowType)} className={selectClass}>
              {options.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
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
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Record" onClose={onClose} />
      </form>
    </Modal>
  );
}

/** Update what the holding is worth today. A valuation changes the value — never the money you put in. */
export function ValuationDialog({ investment, onClose, onSaved }: { investment: InvestmentDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [value, setValue] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iid = investment?.id;
  useEffect(() => {
    if (!iid) return;
    setValue("");
    setDate(localDateString());
    setError(null);
  }, [iid]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!investment) return;
    const v = parseFloat(value);
    if (!Number.isFinite(v) || v < 0) return setError("Enter what it is worth (zero or more).");
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.addValuation(investment.id, { value: v, valuedAt: date });
      emitFinancialChange("investment");
      onSaved(`Value updated to ${formatINR(v)}. The difference from what you put in is a gain or loss, not a contribution.`);
      onClose();
    } catch (err) {
      setError(errText(err, "Could not update the value."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={investment !== null} onClose={onClose} title={`Update value${investment ? ` · ${investment.name}` : ""}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">
          What is it worth right now? Recording a value changes the gain or loss only — it does not add any money you put in.
          {investment && (
            <>
              {" "}
              Last recorded: <span className="money">{formatINR(investment.currentValue)}</span>.
            </>
          )}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("value")} label="Value (₹)">
            <Input id={id("value")} type="number" inputMode="decimal" min="0" step="0.01" value={value} onChange={(e) => setValue(e.target.value)} className="money" required />
          </Field>
          <Field id={id("date")} label="As of">
            <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Update value" onClose={onClose} />
      </form>
    </Modal>
  );
}

const FREQUENCIES = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every 2 weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "YEARLY", label: "Yearly" },
] as const;
type Freq = (typeof FREQUENCIES)[number]["value"];

/** Set up or change a recurring contribution (SIP): amount, frequency, dates and an optional expected return. */
export function ScheduleDialog({
  investment,
  schedule,
  onClose,
  onSaved,
}: {
  investment: InvestmentDTO | null;
  schedule: SipScheduleSummaryDTO | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [amount, setAmount] = useState("");
  const [frequency, setFrequency] = useState<Freq>("MONTHLY");
  const [day, setDay] = useState("");
  const [start, setStart] = useState(() => localDateString());
  const [end, setEnd] = useState("");
  const [expected, setExpected] = useState("");
  const [active, setActive] = useState(true);
  const [confirmBackfill, setConfirmBackfill] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iid = investment?.id;
  useEffect(() => {
    if (!iid) return;
    // A holding with no schedule yet comes back from the API as inactive with no amount: that is a NEW
    // schedule, which should start out active, monthly and beginning today — not copy the empty "off" state.
    const s = schedule?.amountPerPeriod ? schedule : null;
    setAmount(s?.amountPerPeriod ?? "");
    setFrequency((s?.frequency as Freq | undefined) ?? "MONTHLY");
    setDay(s?.contributionDay ? String(s.contributionDay) : "");
    setStart(s?.startDate ? s.startDate.slice(0, 10) : localDateString());
    setEnd(s?.endDate ? s.endDate.slice(0, 10) : "");
    setExpected(s?.expectedAnnualReturn ?? "");
    setActive(s ? s.active : true);
    setConfirmBackfill(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iid]);

  const usesDay = frequency === "MONTHLY" || frequency === "QUARTERLY" || frequency === "YEARLY";
  // Starting before this month means contributions for the past periods would be recorded as ACTUAL
  // contributions, so the user has to say they really happened.
  const startsInPast = start.slice(0, 7) < localDateString().slice(0, 7);
  const needsBackfillConfirm = active && startsInPast;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!investment) return;
    const value = parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return setError("Enter the amount for each contribution.");
    if (end && end < start) return setError("The end date cannot be before the start date.");
    if (needsBackfillConfirm && !confirmBackfill) return setError("Tick the box to confirm the past contributions really happened, or choose a start date from this month.");

    const body: SipScheduleInput = {
      monthlyContribution: value,
      frequency,
      startDate: start,
      active,
      ...(usesDay && day ? { contributionDay: parseInt(day, 10) } : {}),
      ...(end ? { endDate: end } : {}),
      ...(expected !== "" ? { expectedAnnualReturn: parseFloat(expected) } : {}),
      ...(needsBackfillConfirm ? { confirmBackfill: true } : {}),
    };
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.setSipSchedule(investment.id, body);
      emitFinancialChange("investment");
      onSaved(active ? "Schedule saved. Due contributions are created automatically — never in advance." : "Schedule saved and paused.");
      onClose();
    } catch (err) {
      setError(errText(err, "Could not save the schedule."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={investment !== null} onClose={onClose} title={`Recurring contribution${investment ? ` · ${investment.name}` : ""}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("amount")} label="Amount each time (₹)">
            <Input id={id("amount")} type="number" inputMode="decimal" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="money" required />
          </Field>
          <Field id={id("freq")} label="How often">
            <select id={id("freq")} value={frequency} onChange={(e) => setFrequency(e.target.value as Freq)} className={selectClass}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </Field>
          <Field id={id("start")} label="Start date">
            <Input id={id("start")} type="date" value={start} onChange={(e) => setStart(e.target.value)} required />
          </Field>
          <Field id={id("end")} label="End date (optional)">
            <Input id={id("end")} type="date" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
          </Field>
          {usesDay && (
            <Field id={id("day")} label="Day of the month" hint="Leave empty to use the start date's day. Short months use their last day.">
              <Input id={id("day")} type="number" inputMode="numeric" min="1" max="31" value={day} onChange={(e) => setDay(e.target.value)} />
            </Field>
          )}
          <Field id={id("expected")} label="Expected return per year, % (optional)" hint="Used only for projections; it never changes any recorded value.">
            <Input id={id("expected")} type="number" inputMode="decimal" min="0" max="100" step="0.1" value={expected} onChange={(e) => setExpected(e.target.value)} />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active — create each contribution when it falls due
        </label>

        {needsBackfillConfirm && (
          <label className="flex items-start gap-2 rounded-md border border-line bg-surface-muted p-3 text-sm text-ink">
            <input type="checkbox" checked={confirmBackfill} onChange={(e) => setConfirmBackfill(e.target.checked)} className="mt-0.5" />
            <span>The start date is in the past. Contributions for the periods since then will be recorded as real contributions you already made.</span>
          </label>
        )}

        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Save schedule" onClose={onClose} />
      </form>
    </Modal>
  );
}

/** Record a sale: the tax record, and — by default — the proceeds reaching your cash, in one step. */
export function SaleDialog({ investment, onClose, onSaved }: { investment: InvestmentDTO | null; onClose: () => void; onSaved: (message: string) => void }) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [proceeds, setProceeds] = useState("");
  const [costPortion, setCostPortion] = useState("");
  const [date, setDate] = useState(() => localDateString());
  const [notes, setNotes] = useState("");
  const [addToCash, setAddToCash] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const iid = investment?.id;
  useEffect(() => {
    if (!iid) return;
    setProceeds("");
    setCostPortion("");
    setDate(localDateString());
    setNotes("");
    setAddToCash(true);
    setError(null);
  }, [iid]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!investment) return;
    const p = parseFloat(proceeds);
    const c = parseFloat(costPortion);
    if (!Number.isFinite(p) || p <= 0) return setError("Enter the amount you received.");
    if (!Number.isFinite(c) || c < 0) return setError("Enter the part of your original cost that this sale covers (zero or more).");
    setSubmitting(true);
    setError(null);
    try {
      await api.investments.recordSale(investment.id, { saleDate: date, proceeds: p, costBasisPortion: c, notes: notes.trim() || undefined, ...(addToCash ? { alsoRecordCashflow: true } : {}) });
      emitFinancialChange("investment");
      onSaved(
        addToCash
          ? `Sale recorded and ${formatINR(p)} added to your cash. Update the holding's value to reflect what you still own.`
          : "Sale recorded for tax. Your cash was not changed — add the proceeds as a sale transaction if they reached your account.",
      );
      onClose();
    } catch (err) {
      setError(errText(err, "Could not record this sale."));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={investment !== null} onClose={onClose} title={`Record a sale${investment ? ` · ${investment.name}` : ""}`}>
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={id("proceeds")} label="Amount received (₹)">
            <Input id={id("proceeds")} type="number" inputMode="decimal" min="0" step="0.01" value={proceeds} onChange={(e) => setProceeds(e.target.value)} className="money" required />
          </Field>
          <Field id={id("cost")} label="Original cost of what you sold (₹)" hint="Used to work out the gain for tax.">
            <Input id={id("cost")} type="number" inputMode="decimal" min="0" step="0.01" value={costPortion} onChange={(e) => setCostPortion(e.target.value)} className="money" required />
          </Field>
          <Field id={id("date")} label="Sale date">
            <Input id={id("date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field id={id("notes")} label="Notes (optional)">
            <Input id={id("notes")} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
        </div>
        <label className="flex items-start gap-2 rounded-md border border-line bg-surface-muted p-3 text-sm text-ink">
          <input type="checkbox" checked={addToCash} onChange={(e) => setAddToCash(e.target.checked)} className="mt-0.5" />
          <span>Add the amount received to my cash (recommended). The sale is not income.</span>
        </label>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <Actions submitting={submitting} label="Record sale" onClose={onClose} />
      </form>
    </Modal>
  );
}
