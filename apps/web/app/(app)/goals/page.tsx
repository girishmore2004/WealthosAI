"use client";

import { useEffect, useState, FormEvent } from "react";
import type { GoalDTO, GoalType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { formatINR } from "@/lib/format";

const TYPES: GoalType[] = [
  "EMERGENCY_FUND",
  "HOUSE",
  "LAND",
  "CAR",
  "MARRIAGE",
  "CHILD_EDUCATION",
  "RETIREMENT",
  "EARLY_RETIREMENT",
  "BUSINESS_EXPANSION",
  "VACATION",
  "HEALTHCARE_RESERVE",
  "PASSIVE_INCOME",
  "FAMILY_SUPPORT",
  "OTHER",
];

const STATUS_STYLES: Record<GoalDTO["probabilityOfSuccess"], string> = {
  ON_TRACK: "text-gain",
  AT_RISK: "text-marigold-600",
  OFF_TRACK: "text-loss",
};

const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: TYPES.map((t) => ({ value: t, label: t })) },
  { key: "name", label: "Goal name" },
  { key: "targetAmount", label: "Target amount (₹)", type: "number", money: true },
  { key: "targetDate", label: "Target date", type: "date" },
  { key: "currentAmount", label: "Current amount saved (₹)", type: "number", money: true },
  { key: "monthlyContribution", label: "Monthly contribution (₹)", type: "number", money: true },
];

export default function GoalsPage() {
  const [items, setItems] = useState<GoalDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [type, setType] = useState<GoalType>("EMERGENCY_FUND");
  const [name, setName] = useState("");
  const [targetAmount, setTargetAmount] = useState("");
  const [targetDate, setTargetDate] = useState("");
  const [monthlyContribution, setMonthlyContribution] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.goals
      .list()
      .then(setItems)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load goals."))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.goals.create({
        type,
        name,
        targetAmount: parseFloat(targetAmount),
        targetDate: new Date(targetDate).toISOString(),
        monthlyContribution: monthlyContribution ? parseFloat(monthlyContribution) : 0,
      });
      setName("");
      setTargetAmount("");
      setTargetDate("");
      setMonthlyContribution("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this goal.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.goals.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.goals.update(id, {
      type: values.type as string,
      name: values.name as string,
      targetAmount: parseFloat(values.targetAmount as string),
      targetDate: new Date(values.targetDate as string).toISOString(),
      currentAmount: parseFloat(values.currentAmount as string),
      monthlyContribution: parseFloat(values.monthlyContribution as string),
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Goals</h1>
        <p className="text-sm text-ink-soft">Emergency fund, house, retirement, and everything you&apos;re saving toward.</p>
      </div>

      <Card title="Add goal">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <select value={type} onChange={(e) => setType(e.target.value as GoalType)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, " ").toLowerCase()}
              </option>
            ))}
          </select>
          <Input placeholder="Goal name (e.g. 6-month emergency fund)" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} required />
          <Input type="number" min="0" placeholder="Target amount (₹)" value={targetAmount} onChange={(e) => setTargetAmount(e.target.value)} required className="money" />
          <Input type="number" min="0" placeholder="Monthly contribution (₹)" value={monthlyContribution} onChange={(e) => setMonthlyContribution(e.target.value)} className="money" />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add goal"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No goals set yet.</p>
        ) : (
          items.map((goal) => (
            <Card key={goal.id}>
              {editingId === goal.id ? (
                <InlineEditForm
                  fields={EDIT_FIELDS}
                  initialValues={{
                    type: goal.type,
                    name: goal.name,
                    targetAmount: goal.targetAmount,
                    targetDate: goal.targetDate.slice(0, 10),
                    currentAmount: goal.currentAmount,
                    monthlyContribution: goal.monthlyContribution,
                  }}
                  onSave={(values) => onUpdate(goal.id, values)}
                  onCancel={() => setEditingId(null)}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm font-medium text-ink">{goal.name}</p>
                      <p className="text-xs text-ink-faint">
                        {goal.type.replace(/_/g, " ").toLowerCase()} · by {new Date(goal.targetDate).toLocaleDateString("en-IN")}
                      </p>
                    </div>
                    <span className={`money text-xs font-medium ${STATUS_STYLES[goal.probabilityOfSuccess]}`}>
                      {goal.probabilityOfSuccess.replace("_", " ")}
                    </span>
                  </div>
                  <div className="mt-3 h-1.5 w-full rounded-full bg-line">
                    <div
                      className="h-1.5 rounded-full bg-marigold-500"
                      style={{ width: `${Math.min(100, goal.progressPercent)}%` }}
                    />
                  </div>
                  <div className="mt-2 flex justify-between text-xs text-ink-soft">
                    <span className="money">{formatINR(goal.targetAmount)}</span>
                    <span>{goal.progressPercent}% there</span>
                  </div>
                  <p className="mt-2 text-xs text-ink-faint">
                    Needs about <span className="money">{formatINR(goal.requiredMonthlyContribution)}</span>/month to stay on track
                    (currently contributing <span className="money">{formatINR(goal.monthlyContribution)}</span>).
                  </p>
                  <div className="mt-3 flex gap-3">
                    <button onClick={() => setEditingId(goal.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                      Edit
                    </button>
                    <button onClick={() => onDelete(goal.id)} className="text-xs text-ink-faint hover:text-loss">
                      Remove goal
                    </button>
                  </div>
                </>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
