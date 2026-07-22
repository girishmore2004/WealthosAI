"use client";

import { useEffect, useState, FormEvent } from "react";
import type { ScenarioType, RunScenarioResponseDTO, SavedScenarioDTO, LoanDTO, GoalDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  lookup?: "loans" | "goals"; // rendered as a populated <select> instead of free text
}

const SCENARIO_FIELDS: Record<ScenarioType, FieldDef[]> = {
  SALARY_HIKE: [{ key: "percentIncrease", label: "Salary increase (%)" }],
  SALARY_DROP: [{ key: "percentDecrease", label: "Salary decrease (%)" }],
  SIP_INCREASE: [{ key: "additionalMonthlyAmount", label: "Additional monthly SIP (₹)" }],
  SIP_DECREASE: [{ key: "reducedMonthlyAmount", label: "Reduced monthly SIP (₹)" }],
  HOUSE_PURCHASE: [
    { key: "propertyValue", label: "Property value (₹)" },
    { key: "downPaymentPercent", label: "Down payment (%)" },
    { key: "loanInterestRateAnnual", label: "Loan interest rate (%/yr)" },
    { key: "loanTenureMonths", label: "Loan tenure (months)" },
  ],
  LOAN_PREPAYMENT: [
    { key: "loanId", label: "Loan", lookup: "loans" },
    { key: "lumpSum", label: "Lump sum to prepay (₹)" },
  ],
  RETIREMENT_AGE_SHIFT: [{ key: "newRetirementAge", label: "New retirement age" }],
  EMERGENCY_EXPENSE: [{ key: "amount", label: "Expense amount (₹)" }],
  GOAL_DELAY: [
    { key: "goalId", label: "Goal", lookup: "goals" },
    { key: "delayMonths", label: "Delay by (months)" },
  ],
};

const SCENARIO_LABELS: Record<ScenarioType, string> = {
  SALARY_HIKE: "Salary hike",
  SALARY_DROP: "Salary drop",
  SIP_INCREASE: "Increase SIP",
  SIP_DECREASE: "Decrease SIP",
  HOUSE_PURCHASE: "Buy a house",
  LOAN_PREPAYMENT: "Prepay a loan",
  RETIREMENT_AGE_SHIFT: "Shift retirement age",
  EMERGENCY_EXPENSE: "Emergency expense",
  GOAL_DELAY: "Delay a goal",
};

export default function SimulatorPage() {
  const [scenarioType, setScenarioType] = useState<ScenarioType>("SALARY_HIKE");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>({});
  const [response, setResponse] = useState<RunScenarioResponseDTO | null>(null);
  const [saved, setSaved] = useState<SavedScenarioDTO[]>([]);
  const [label, setLabel] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedForCompare, setSelectedForCompare] = useState<string[]>([]);
  const [comparison, setComparison] = useState<SavedScenarioDTO[] | null>(null);
  const [loadingSaved, setLoadingSaved] = useState(true);
  const [loans, setLoans] = useState<LoanDTO[]>([]);
  const [goals, setGoals] = useState<GoalDTO[]>([]);

  const loadSaved = () => {
    api.simulator.listSaved().then(setSaved).catch(() => {}).finally(() => setLoadingSaved(false));
  };
  useEffect(loadSaved, []);
  useEffect(() => {
    api.loans.list().then(setLoans).catch(() => {});
    api.goals.list().then(setGoals).catch(() => {});
  }, []);

  const buildParams = (): Record<string, unknown> => {
    const params: Record<string, unknown> = {};
    for (const field of SCENARIO_FIELDS[scenarioType]) {
      const raw = fieldValues[field.key];
      params[field.key] = field.key === "loanId" || field.key === "goalId" ? raw : parseFloat(raw ?? "0");
    }
    return params;
  };

  const onRun = async (e: FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      const result = await api.simulator.run(scenarioType, buildParams());
      setResponse(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not run this scenario.");
    } finally {
      setRunning(false);
    }
  };

  const onSave = async () => {
    if (!label.trim()) return;
    try {
      await api.simulator.save(scenarioType, buildParams(), label);
      setLabel("");
      loadSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this scenario.");
    }
  };

  const onDelete = async (id: string) => {
    await api.simulator.removeSaved(id);
    loadSaved();
  };

  const toggleCompare = (id: string) => {
    setSelectedForCompare((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const onCompare = async () => {
    if (selectedForCompare.length < 2) return;
    const result = await api.simulator.compare(selectedForCompare);
    setComparison(result);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">What-If Simulator</h1>
        <p className="text-sm text-ink-soft">
          Deterministic, assumption-labeled projections — not guarantees. Every number is recomputed the same way
          every time from the same inputs.
        </p>
      </div>

      <Card title="Run a scenario">
        <form onSubmit={onRun} className="space-y-3">
          <select
            value={scenarioType}
            onChange={(e) => {
              setScenarioType(e.target.value as ScenarioType);
              setFieldValues({});
            }}
            className="w-full rounded-sm border border-line bg-surface px-3 py-2 text-sm sm:w-auto"
          >
            {(Object.keys(SCENARIO_LABELS) as ScenarioType[]).map((t) => (
              <option key={t} value={t}>
                {SCENARIO_LABELS[t]}
              </option>
            ))}
          </select>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {SCENARIO_FIELDS[scenarioType].map((field) => {
              if (field.lookup === "loans") {
                return (
                  <select
                    key={field.key}
                    value={fieldValues[field.key] ?? ""}
                    onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
                    required
                  >
                    <option value="" disabled>
                      {loans.length === 0 ? "No loans found — add one under Money → Loans" : "Select a loan…"}
                    </option>
                    {loans.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.lender} — {formatINR(l.outstandingPrincipal)} outstanding
                      </option>
                    ))}
                  </select>
                );
              }
              if (field.lookup === "goals") {
                return (
                  <select
                    key={field.key}
                    value={fieldValues[field.key] ?? ""}
                    onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                    className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
                    required
                  >
                    <option value="" disabled>
                      {goals.length === 0 ? "No goals found — add one under Goals" : "Select a goal…"}
                    </option>
                    {goals.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} — {formatINR(g.targetAmount)} target
                      </option>
                    ))}
                  </select>
                );
              }
              return (
                <Input
                  key={field.key}
                  placeholder={field.label}
                  value={fieldValues[field.key] ?? ""}
                  onChange={(e) => setFieldValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  className="money"
                  required
                />
              );
            })}
          </div>
          <Button type="submit" disabled={running}>
            {running ? "Calculating…" : "Run scenario"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      {response && (
        <Card title="Result">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Monthly cashflow change</p>
              <p className={`money mt-1 text-lg ${Number(response.result.monthlyCashflowDelta) >= 0 ? "text-gain" : "text-loss"}`}>
                {formatINR(response.result.monthlyCashflowDelta)}
              </p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Net worth change (5yr projection)</p>
              <p className={`money mt-1 text-lg ${Number(response.result.netWorthDeltaIn5Years) >= 0 ? "text-gain" : "text-loss"}`}>
                {formatINR(response.result.netWorthDeltaIn5Years)}
              </p>
            </div>
          </div>
          <p className="mt-3 text-sm text-ink">{response.result.narrative}</p>
          <p className="mt-2 text-sm text-ink-soft">{response.result.goalImpact}</p>
          <div className="mt-3">
            <p className="text-xs uppercase tracking-wide text-ink-faint">Assumptions</p>
            <ul className="mt-1 list-inside list-disc text-xs text-ink-faint">
              {response.result.assumptions.map((a, i) => (
                <li key={i}>{a}</li>
              ))}
            </ul>
          </div>
          <div className="mt-4 flex gap-2">
            <Input placeholder="Label this scenario to save it" value={label} onChange={(e) => setLabel(e.target.value)} />
            <Button variant="secondary" onClick={onSave}>
              Save
            </Button>
          </div>
        </Card>
      )}

      <Card title="Saved scenarios">
        {loadingSaved ? (
          <p className="text-sm text-ink-faint">Loading saved scenarios…</p>
        ) : saved.length === 0 ? (
          <p className="text-sm text-ink-faint">No saved scenarios yet — run one above and save it to compare later.</p>
        ) : (
          <>
            <ul>
              {saved.map((s, i) => (
                <li key={s.id} className={`flex items-center justify-between py-2 text-sm ${i !== saved.length - 1 ? "ledger-rule" : ""}`}>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={selectedForCompare.includes(s.id)}
                      onChange={() => toggleCompare(s.id)}
                      className="h-4 w-4 accent-marigold-500"
                    />
                    <span className="text-ink">{s.label}</span>
                    <span className="text-xs text-ink-faint">({SCENARIO_LABELS[s.scenarioType]})</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <span className="money text-ink">{formatINR(s.result.netWorthDeltaIn5Years)}</span>
                    <button onClick={() => onDelete(s.id)} className="text-xs text-ink-faint hover:text-loss">
                      Remove
                    </button>
                  </div>
                </li>
              ))}
            </ul>
            <Button variant="secondary" onClick={onCompare} disabled={selectedForCompare.length < 2} className="mt-3">
              Compare selected ({selectedForCompare.length})
            </Button>
          </>
        )}
      </Card>

      {comparison && (
        <Card title="Comparison">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-ink-faint">
                <th className="pb-2">Scenario</th>
                <th className="pb-2 text-right">Cashflow/mo</th>
                <th className="pb-2 text-right">Net worth (5yr)</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((c) => (
                <tr key={c.id} className="ledger-rule">
                  <td className="py-2 text-ink">{c.label}</td>
                  <td className="money py-2 text-right">{formatINR(c.result.monthlyCashflowDelta)}</td>
                  <td className="money py-2 text-right">{formatINR(c.result.netWorthDeltaIn5Years)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </Card>
      )}
    </div>
  );
}
