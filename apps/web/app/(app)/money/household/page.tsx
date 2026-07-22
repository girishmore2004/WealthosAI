"use client";

import { useEffect, useState, FormEvent } from "react";
import type { HouseholdSummaryDTO, HouseholdDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

export default function HouseholdPage() {
  const [summary, setSummary] = useState<HouseholdSummaryDTO | null>(null);
  const [household, setHousehold] = useState<HouseholdDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [relation, setRelation] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    Promise.all([api.household.summary(), api.household.get()])
      .then(([s, h]) => {
        setSummary(s);
        setHousehold(h);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load household data."));
  };

  useEffect(load, []);

  const onAddDependent = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !relation.trim()) return;
    setSubmitting(true);
    try {
      await api.household.addDependent({ name, relation });
      setName("");
      setRelation("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not add this dependent.");
    } finally {
      setSubmitting(false);
    }
  };

  const onRemoveDependent = async (id: string) => {
    await api.household.removeDependent(id);
    load();
  };

  if (!summary || !household) {
    return <p className="text-sm text-ink-faint">{error ?? "Loading household…"}</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">{summary.householdName}</h1>
        <p className="text-sm text-ink-soft">
          {summary.memberCount} member{summary.memberCount === 1 ? "" : "s"} · viewing as{" "}
          <span className="font-medium">{summary.viewerRole === "OWNER" ? "Owner" : "Member"}</span>
        </p>
      </div>

      {error && <p className="text-sm text-loss">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Household net worth</p>
          <p className="money mt-1 text-xl text-ink">{formatINR(summary.totalNetWorth)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Combined monthly income</p>
          <p className="money mt-1 text-xl text-gain">{formatINR(summary.totalMonthlyIncome)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Combined monthly expenses</p>
          <p className="money mt-1 text-xl text-loss">{formatINR(summary.totalMonthlyExpenses)}</p>
        </Card>
        <Card>
          <p className="text-xs uppercase tracking-wide text-ink-faint">Open alerts</p>
          <p className="money mt-1 text-xl text-ink">{summary.totalUnreadAlerts}</p>
        </Card>
      </div>

      <Card title="Assets & liabilities">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <p className="text-xs text-ink-faint">Investments</p>
            <p className="money text-sm text-ink">{formatINR(summary.totalInvestments)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Property</p>
            <p className="money text-sm text-ink">{formatINR(summary.totalPropertyValue)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Debt</p>
            <p className="money text-sm text-ink">{formatINR(summary.totalDebt)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Goals saved / target</p>
            <p className="money text-sm text-ink">
              {formatINR(summary.totalGoalsSaved)} / {formatINR(summary.totalGoalsTarget)}
            </p>
          </div>
          <div>
            <p className="text-xs text-ink-faint">Business profit (mo.)</p>
            <p className="money text-sm text-ink">{formatINR(summary.totalBusinessProfitThisMonth)}</p>
          </div>
        </div>
      </Card>

      {summary.possibleSharedSubscriptions.length > 0 && (
        <Card title="Possibly shared subscriptions">
          <p className="mb-2 text-xs text-ink-faint">
            Same merchant detected for multiple members — could be one shared account, or genuinely separate ones.
          </p>
          <ul>
            {summary.possibleSharedSubscriptions.map((s, i) => (
              <li key={s.merchant} className={`py-1.5 text-sm ${i !== summary.possibleSharedSubscriptions.length - 1 ? "ledger-rule" : ""}`}>
                <span className="text-ink capitalize">{s.merchant}</span>
                {s.memberNames.length > 0 && (
                  <span className="text-xs text-ink-faint"> — {s.memberNames.filter(Boolean).join(", ")}</span>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {summary.viewerRole === "OWNER" && summary.members && (
        <Card title="Per-member breakdown">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-ink-faint">
                  <th className="pb-2">Member</th>
                  <th className="pb-2 text-right">Net worth</th>
                  <th className="pb-2 text-right">Income/mo</th>
                  <th className="pb-2 text-right">Expenses/mo</th>
                  <th className="pb-2 text-right">Goals</th>
                  <th className="pb-2 text-right">Alerts</th>
                </tr>
              </thead>
              <tbody>
                {summary.members.map((m) => (
                  <tr key={m.userId} className="ledger-rule">
                    <td className="py-2 text-ink">
                      {m.name ?? "—"} <span className="text-xs text-ink-faint">({m.role.toLowerCase()})</span>
                    </td>
                    <td className="money py-2 text-right">{formatINR(m.netWorth)}</td>
                    <td className="money py-2 text-right text-gain">{formatINR(m.monthlyIncome)}</td>
                    <td className="money py-2 text-right text-loss">{formatINR(m.monthlyExpenses)}</td>
                    <td className="py-2 text-right">{m.goalCount}</td>
                    <td className="py-2 text-right">{m.unreadAlertCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {summary.viewerRole === "MEMBER" && (
        <p className="text-[11px] text-ink-faint">
          As a member, you see household-wide totals only. Per-member detail is visible to the household owner.
        </p>
      )}

      <Card title="Dependents">
        {household.dependents.length === 0 ? (
          <p className="mb-3 text-sm text-ink-faint">No dependents added yet.</p>
        ) : (
          <ul className="mb-3">
            {household.dependents.map((d, i) => (
              <li key={d.id} className={`flex items-center justify-between py-1.5 text-sm ${i !== household.dependents.length - 1 ? "ledger-rule" : ""}`}>
                <span className="text-ink">
                  {d.name} <span className="text-xs text-ink-faint">({d.relation})</span>
                </span>
                <button onClick={() => onRemoveDependent(d.id)} className="text-xs text-ink-faint hover:text-loss">
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={onAddDependent} className="flex flex-wrap gap-2">
          <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} className="flex-1" />
          <Input placeholder="Relation (e.g. Spouse, Child)" value={relation} onChange={(e) => setRelation(e.target.value)} className="flex-1" />
          <Button type="submit" variant="secondary" disabled={submitting}>
            Add dependent
          </Button>
        </form>
      </Card>

      <p className="text-[11px] text-ink-faint">
        Aggregates sum each member&apos;s own accounts exactly once — this app doesn&apos;t yet model jointly-owned
        assets (e.g. a property owned by two spouses together), so those would still show under one person&apos;s name.
      </p>
    </div>
  );
}
