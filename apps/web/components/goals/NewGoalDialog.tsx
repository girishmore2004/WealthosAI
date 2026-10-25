"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import type { GoalDTO, GoalType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange } from "@/lib/financial-events";
import { GOAL_TYPES, goalTypeLabel } from "@/lib/goal-types";
import { localDateString } from "@/lib/dates";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";

/** Create a goal. One goal record, used everywhere: it appears on the Goals overview and in Money → Goals at once. */
export function NewGoalDialog({
  open,
  hasEmergencyFund,
  onClose,
  onCreated,
}: {
  open: boolean;
  /** An emergency fund already exists — only one is allowed, so the type is not offered again. */
  hasEmergencyFund: boolean;
  onClose: () => void;
  onCreated: (goal: GoalDTO) => void;
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const types = GOAL_TYPES.filter((t) => !(hasEmergencyFund && t === "EMERGENCY_FUND"));
  const [type, setType] = useState<GoalType>(types[0] ?? "OTHER");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [date, setDate] = useState("");
  const [saved, setSaved] = useState("");
  const [monthly, setMonthly] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(types[0] ?? "OTHER");
    setName("");
    setTarget("");
    setDate("");
    setSaved("");
    setMonthly("");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    const targetAmount = parseFloat(target);
    if (!name.trim()) return setError("Give the goal a name.");
    if (!Number.isFinite(targetAmount) || targetAmount <= 0) return setError("Enter a target amount greater than zero.");
    if (!date) return setError("Choose a target date.");
    const savedValue = saved.trim() === "" ? undefined : parseFloat(saved);
    if (savedValue !== undefined && (!Number.isFinite(savedValue) || savedValue < 0)) return setError("Already saved cannot be negative.");
    const monthlyValue = monthly.trim() === "" ? undefined : parseFloat(monthly);
    if (monthlyValue !== undefined && (!Number.isFinite(monthlyValue) || monthlyValue < 0)) return setError("Monthly contribution cannot be negative.");

    setSubmitting(true);
    setError(null);
    try {
      const goal = await api.goals.create({
        type,
        name: name.trim(),
        targetAmount,
        targetDate: new Date(date).toISOString(),
        ...(savedValue ? { currentAmount: savedValue } : {}),
        ...(monthlyValue ? { monthlyContribution: monthlyValue } : {}),
      });
      emitFinancialChange("goal");
      if (type === "EMERGENCY_FUND") emitFinancialChange("emergency");
      onCreated(goal);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not create this goal.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="New goal">
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <p className="text-sm text-ink-soft">Every goal gets its own balance, history and plan in Money → Goals — nothing else to set up.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor={id("type")} className="mb-1 block text-xs font-medium text-ink-soft">
              Type
            </label>
            <select id={id("type")} value={type} onChange={(e) => setType(e.target.value as GoalType)} className={selectClass}>
              {types.map((t) => (
                <option key={t} value={t}>
                  {goalTypeLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={id("name")} className="mb-1 block text-xs font-medium text-ink-soft">
              Goal name
            </label>
            <Input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. House down payment" maxLength={120} />
          </div>
          <div>
            <label htmlFor={id("target")} className="mb-1 block text-xs font-medium text-ink-soft">
              Target amount (₹)
            </label>
            <Input id={id("target")} type="number" inputMode="decimal" min="0" step="0.01" value={target} onChange={(e) => setTarget(e.target.value)} className="money" />
          </div>
          <div>
            <label htmlFor={id("date")} className="mb-1 block text-xs font-medium text-ink-soft">
              Target date
            </label>
            <Input id={id("date")} type="date" value={date} min={localDateString()} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor={id("saved")} className="mb-1 block text-xs font-medium text-ink-soft">
              Already saved (₹, optional)
            </label>
            <Input id={id("saved")} type="number" inputMode="decimal" min="0" step="0.01" value={saved} onChange={(e) => setSaved(e.target.value)} className="money" />
          </div>
          <div>
            <label htmlFor={id("monthly")} className="mb-1 block text-xs font-medium text-ink-soft">
              Monthly contribution (₹, optional)
            </label>
            <Input id={id("monthly")} type="number" inputMode="decimal" min="0" step="0.01" value={monthly} onChange={(e) => setMonthly(e.target.value)} className="money" />
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Create goal"}
          </Button>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}
