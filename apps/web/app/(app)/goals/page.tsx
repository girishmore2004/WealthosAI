"use client";

import Link from "next/link";
import { useEffect, useState, FormEvent } from "react";
import type { GoalDTO, GoalType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { Badge } from "@/components/ui/Badge";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { GOAL_TYPES, goalHref } from "@/lib/goal-types";
import { formatINR } from "@/lib/format";

// GOALS OVERVIEW — planning and tracking: create, edit, see progress, deadline, on-track status, shortfall and
// the monthly amount a goal needs. The money itself (add, use, move, history, funding) is managed in
// Money → Goals; each card links straight to that goal there. This page never holds a second copy of a goal.

const STATUS_BADGE: Record<GoalDTO["probabilityOfSuccess"], { tone: "success" | "warning" | "critical"; label: string }> = {
  // "probabilityOfSuccess" is a pace-comparison heuristic (monthly contribution vs. the pace required to hit
  // the target date), not a modeled statistical probability — the field name predates that distinction and
  // is kept for backward compatibility (see GoalDTO.isPaceHeuristic's own doc comment). A title attribute on
  // each badge makes the disclosure available in-context.
  ON_TRACK: { tone: "success", label: "On track" },
  AT_RISK: { tone: "warning", label: "At risk" },
  OFF_TRACK: { tone: "critical", label: "Off track" },
};

const STATUS_TOOLTIP =
  "Based on your contribution pace versus the pace needed to hit this goal's target date — a simple comparison, not a statistically modeled probability.";

const PROGRESS_BAR: Record<GoalDTO["probabilityOfSuccess"], string> = {
  ON_TRACK: "bg-gain",
  AT_RISK: "bg-warn",
  OFF_TRACK: "bg-loss",
};

// The amount saved is not editable here: it is the balance of the goal's ledger and only changes when money
// is added, used or moved in Money → Goals.
const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: GOAL_TYPES.map((t) => ({ value: t, label: t })) },
  { key: "name", label: "Goal name" },
  { key: "targetAmount", label: "Target amount (₹)", type: "number", money: true },
  { key: "targetDate", label: "Target date", type: "date" },
  { key: "monthlyContribution", label: "Monthly contribution (₹)", type: "number", money: true },
];

export default function GoalsPage() {
  const version = useFinancialVersion(["goal", "emergency", "investment"]);
  const [items, setItems] = useState<GoalDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(false);

  const [type, setType] = useState<GoalType>("HOUSE");
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [saved, setSaved] = useState("");
  const [monthlyContribution, setMonthlyContribution] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    api.goals
      .list(showClosed ? { archived: true } : {})
      .then((list) => active && setItems(list))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : "Could not load goals."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [version, showClosed]);

  const active = items.filter((g) => !g.archivedAt);
  const closed = items.filter((g) => g.archivedAt);
  // Only one emergency fund is allowed, so the type is not offered again once there is one.
  const hasEmergency = active.some((g) => g.type === "EMERGENCY_FUND");
  const types = GOAL_TYPES.filter((t) => !(hasEmergency && t === "EMERGENCY_FUND"));

  const changed = (g?: Pick<GoalDTO, "type">) => {
    emitFinancialChange("goal");
    if (g?.type === "EMERGENCY_FUND") emitFinancialChange("emergency");
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const savedValue = saved ? parseFloat(saved) : 0;
      const created = await api.goals.create({
        type,
        name,
        targetAmount: parseFloat(targetAmount),
        targetDate: new Date(targetDate).toISOString(),
        monthlyContribution: monthlyContribution ? parseFloat(monthlyContribution) : 0,
        ...(savedValue > 0 ? { currentAmount: savedValue } : {}),
      });
      setName("");
      setTargetAmount("");
      setTargetDate("");
      setSaved("");
      setMonthlyContribution("");
      changed(created ?? { type });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this goal.");
    } finally {
      setSubmitting(false);
    }
  };

  const onRemove = async (goal: GoalDTO) => {
    setError(null);
    try {
      const r = await api.goals.remove(goal.id);
      setConfirmRemoveId(null);
      setNotice(
        r?.archived
          ? `${goal.name} was closed${r.releasedAmount && Number(r.releasedAmount) > 0 ? ` and ${formatINR(r.releasedAmount)} returned to your cash` : ""}. You can restore it from “Show closed goals”.`
          : `${goal.name} was deleted.`,
      );
      changed(goal);
    } catch (err) {
      setConfirmRemoveId(null);
      setError(err instanceof ApiError ? err.message : "Could not remove this goal.");
    }
  };

  const onRestore = async (goal: GoalDTO) => {
    setError(null);
    try {
      await api.goals.restore(goal.id);
      setNotice(`${goal.name} was restored.`);
      changed(goal);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not restore this goal.");
    }
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.goals.update(id, {
      type: values.type as string,
      name: values.name as string,
      targetAmount: parseFloat(values.targetAmount as string),
      targetDate: new Date(values.targetDate as string).toISOString(),
      monthlyContribution: parseFloat(values.monthlyContribution as string),
    });
    setEditingId(null);
    changed(items.find((g) => g.id === id));
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-2xl text-ink sm:text-3xl">Goals</h1>
        <p className="text-sm text-ink-soft">
          Emergency fund, house, retirement, and everything you&apos;re saving toward. To add, use or move the money in a goal, open it in{" "}
          <Link href="/money/goals" className="text-marigold-600 hover:underline">
            Money → Goals
          </Link>
          .
        </p>
      </div>

      <Card title="Add goal">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select aria-label="Goal type" value={type} onChange={(e) => setType(e.target.value as GoalType)} className="rounded-md border border-line bg-surface px-3 py-2.5 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30">
            {types.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Goal name (e.g. 6-month emergency fund)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} required />
          <Input type="number" min="0" placeholder="Target amount (₹)" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} required className="money" />
          <Input type="number" min="0" placeholder="Already saved (₹, optional)" value={saved} onChange={(e) => setSaved(e.target.value)} className="money" />
          <Input type="number" min="0" placeholder="Monthly contribution (₹)" value={monthlyContribution} onChange={(e) => setMonthlyContribution(e.target.value)} className="money" />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add goal"}
          </Button>
        </form>
        {error && (
          <p role="alert" className="mt-2 text-sm text-loss">
            {error}
          </p>
        )}
      </Card>

      {notice && (
        <p role="status" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}

      <div className="grid gap-5 md:grid-cols-2">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-ink-faint">No goals set yet.</p>
        ) : (
          active.map((goal) => {
            const noDate = goal.hasTargetDate === false;
            const shortfall = goal.shortfall ?? null;
            const funded = shortfall !== null && Number(shortfall) === 0 && Number(goal.targetAmount) > 0;
            return (
              <Card key={goal.id} hover>
                {editingId === goal.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      type: goal.type,
                      name: goal.name,
                      targetAmount: goal.targetAmount,
                      targetDate: goal.targetDate.slice(0, 10),
                      monthlyContribution: goal.monthlyContribution,
                    }}
                    onSave={(values) => onUpdate(goal.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-medium text-ink">{goal.name}</p>
                        <p className="text-xs text-ink-faint">
                          {goal.type.replace(/_/g, " ").toLowerCase()} · {noDate ? "no target date" : `by ${new Date(goal.targetDate).toLocaleDateString("en-IN")}`}
                        </p>
                      </div>
                      <span title={STATUS_TOOLTIP}>
                        <Badge tone={STATUS_BADGE[goal.probabilityOfSuccess].tone}>{STATUS_BADGE[goal.probabilityOfSuccess].label}</Badge>
                      </span>
                    </div>
                    <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-line">
                      <div className={`h-2 rounded-full transition-all ${PROGRESS_BAR[goal.probabilityOfSuccess]}`} style={{ width: `${Math.min(100, goal.progressPercent)}%` }} />
                    </div>
                    <div className="mt-2 flex justify-between text-xs text-ink-soft">
                      <span className="money">{formatINR(goal.targetAmount)}</span>
                      <span className="font-medium">{goal.progressPercent}% there</span>
                    </div>
                    <p className="mt-2 text-xs text-ink-soft">
                      Saved <span className="money">{formatINR(goal.currentAmount)}</span>
                      {Number(goal.linkedInvestmentValue) > 0 && (
                        <>
                          {" "}
                          + <span className="money">{formatINR(goal.linkedInvestmentValue)}</span> in linked investments
                        </>
                      )}
                      {" · "}
                      {funded ? <span className="font-medium text-gain">fully funded</span> : shortfall !== null ? <>shortfall <span className="money">{formatINR(shortfall)}</span></> : null}
                    </p>
                    {noDate ? (
                      <p className="mt-2 text-xs text-ink-faint">Set a target date to see what it would take each month.</p>
                    ) : (
                      <p className="mt-2 text-xs text-ink-faint">
                        Needs about <span className="money">{formatINR(goal.requiredMonthlyContribution)}</span>/month to stay on track (currently contributing <span className="money">{formatINR(goal.monthlyContribution)}</span>).
                      </p>
                    )}
                    {/* The honest underlying number (contributionPaceRatio) instead of leaving "On track" / "At risk" /
                        "Off track" to imply a modeled probability on its own. */}
                    <p className="mt-1 text-[11px] text-ink-faint">
                      Contributing at {Math.round(goal.contributionPaceRatio * 100)}% of the pace needed — a pace comparison, not a modeled probability of success.
                    </p>
                    <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <Link href={goalHref(goal.id)} className="text-xs font-medium text-marigold-600 hover:underline">
                        Manage funding →
                      </Link>
                      <button onClick={() => setEditingId(goal.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                        Edit
                      </button>
                      {confirmRemoveId === goal.id ? (
                        <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm remove goal">
                          <span className="text-ink-soft">Remove this goal? Money set aside returns to your cash; history is kept.</span>
                          <button onClick={() => onRemove(goal)} className="font-medium text-loss hover:underline">
                            Remove
                          </button>
                          <button onClick={() => setConfirmRemoveId(null)} className="text-ink-faint hover:underline">
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button onClick={() => setConfirmRemoveId(goal.id)} className="text-xs text-ink-faint hover:text-loss">
                          Remove goal
                        </button>
                      )}
                    </div>
                  </>
                )}
              </Card>
            );
          })
        )}
      </div>

      <div className="space-y-3">
        <label className="flex items-center gap-2 text-xs text-ink-faint">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed goals
        </label>
        {showClosed && (
          <ul className="space-y-2">
            {closed.length === 0 ? (
              <li className="text-sm text-ink-faint">No closed goals.</li>
            ) : (
              closed.map((goal) => (
                <li key={goal.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2 text-sm">
                  <span className="text-ink">
                    {goal.name} <span className="text-xs text-ink-faint">· {goal.type.replace(/_/g, " ").toLowerCase()} · closed</span>
                  </span>
                  <span className="flex items-center gap-4">
                    <Link href={goalHref(goal.id)} className="text-xs text-marigold-600 hover:underline">
                      View history
                    </Link>
                    <button onClick={() => onRestore(goal)} className="text-xs text-ink-faint hover:text-marigold-600">
                      Restore
                    </button>
                  </span>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </div>
  );
}
