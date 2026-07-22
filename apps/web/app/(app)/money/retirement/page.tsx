"use client";

import { useEffect, useState, FormEvent } from "react";
import type { RetirementProfileDTO, RetirementPlanDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

export default function RetirementPage() {
  const [profile, setProfile] = useState<RetirementProfileDTO | null>(null);
  const [plan, setPlan] = useState<RetirementPlanDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = () => {
    Promise.all([api.retirement.profile(), api.retirement.plan()])
      .then(([p, pl]) => {
        setProfile(p);
        setPlan(pl);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load your retirement plan."));
  };

  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    setSaving(true);
    setError(null);
    try {
      await api.retirement.updateProfile({
        targetRetirementAge: Number(profile.targetRetirementAge),
        desiredMonthlyIncomeToday: Number(profile.desiredMonthlyIncomeToday),
        inflationRatePercent: Number(profile.inflationRatePercent),
        expectedReturnPreRetirementPercent: Number(profile.expectedReturnPreRetirementPercent),
        expectedReturnPostRetirementPercent: Number(profile.expectedReturnPostRetirementPercent),
      });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save your profile.");
    } finally {
      setSaving(false);
    }
  };

  if (!profile) {
    return <p className="text-sm text-ink-faint">Loading your retirement plan…</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Retirement planner</h1>
        <p className="text-sm text-ink-soft">
          A rough, educational projection of the corpus needed to retire comfortably — not a certified retirement plan.
        </p>
      </div>

      {plan && (
        <Card>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Corpus required at retirement</p>
              <p className="money mt-1 text-2xl text-ink">{formatINR(plan.corpusRequired)}</p>
              <p className="mt-1 text-xs text-ink-faint">in {plan.yearsToRetirement} years</p>
            </div>
            <div>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Projected corpus at that point</p>
              <p className={`money mt-1 text-2xl ${plan.onTrack ? "text-gain" : "text-loss"}`}>
                {formatINR(plan.currentRetirementCorpus)}
              </p>
              <p className="mt-1 text-xs text-ink-faint">from EPF/PPF/NPS + retirement-goal contributions, compounded forward</p>
            </div>
          </div>
          <div className="ledger-rule mt-4 pt-4">
            <p className="text-sm text-ink">
              {plan.onTrack ? (
                <>Current trajectory looks <span className="text-gain">on track</span>.</>
              ) : (
                <>
                  Gap of <span className="money text-loss">{formatINR(plan.corpusGap)}</span>. Closing it needs roughly{" "}
                  <span className="money text-ink">{formatINR(plan.requiredMonthlySip)}</span>/month more, invested until retirement.
                </>
              )}
            </p>
          </div>
          <p className="mt-3 text-[11px] text-ink-faint">
            Projection only, based on the inflation and return assumptions below — actual markets and inflation will differ.
          </p>
        </Card>
      )}

      <Card title="Assumptions">
        <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">Target retirement age</label>
            <Input
              type="number"
              value={profile.targetRetirementAge}
              onChange={(e) => setProfile({ ...profile, targetRetirementAge: Number(e.target.value) })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">Desired monthly income (today&apos;s ₹)</label>
            <Input
              type="number"
              className="money"
              value={profile.desiredMonthlyIncomeToday}
              onChange={(e) => setProfile({ ...profile, desiredMonthlyIncomeToday: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">Inflation assumption (%/yr)</label>
            <Input
              type="number"
              step="0.1"
              value={profile.inflationRatePercent}
              onChange={(e) => setProfile({ ...profile, inflationRatePercent: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">Expected return, pre-retirement (%/yr)</label>
            <Input
              type="number"
              step="0.1"
              value={profile.expectedReturnPreRetirementPercent}
              onChange={(e) => setProfile({ ...profile, expectedReturnPreRetirementPercent: e.target.value })}
            />
          </div>
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wide text-ink-faint">Expected return, post-retirement (%/yr)</label>
            <Input
              type="number"
              step="0.1"
              value={profile.expectedReturnPostRetirementPercent}
              onChange={(e) => setProfile({ ...profile, expectedReturnPostRetirementPercent: e.target.value })}
            />
          </div>
          <div className="flex items-end">
            <Button type="submit" disabled={saving} className="w-full">
              {saving ? "Recalculating…" : "Save and recalculate"}
            </Button>
          </div>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>
    </div>
  );
}
