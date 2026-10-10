"use client";

import { useEffect, useState } from "react";
import type { CategoryDTO, EmergencyFundLedgerRowDTO, EmergencyFundOverviewDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { BasisTag, FactBasis } from "@/components/ui/BasisTag";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AddMoneyDialog, PlanDialog, UseMoneyDialog } from "@/components/emergency/EmergencyDialogs";
import { BalanceTrendChart, ContributionVsUseChart } from "@/components/emergency/EmergencyCharts";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

// A common rule of thumb used only to flag low cover in amber; it is not advice, and a target the user
// has set themselves is what progress is measured against.
const LOW_COVERAGE_MONTHS = 3;

const TYPE_LABEL: Record<EmergencyFundLedgerRowDTO["type"], string> = {
  ALLOCATE: "Added",
  WITHDRAWAL: "Used",
  RELEASE: "Released",
  ADJUSTMENT: "Adjustment",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
};

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function Stat({ label, value, sub, basis, children }: { label: string; value?: string; sub?: string; basis?: FactBasis; children?: React.ReactNode }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="stat-label">{label}</p>
        {basis && <BasisTag basis={basis} />}
      </div>
      {value !== undefined && <p className="money mt-2 text-xl font-semibold text-ink">{value}</p>}
      {children}
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

const signedMoney = (v: string) => {
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatINR(Math.abs(n))}`;
};

export default function EmergencyFundPage() {
  const version = useFinancialVersion(["emergency", "expense"]);
  const [overview, setOverview] = useState<EmergencyFundOverviewDTO | null>(null);
  const [ledger, setLedger] = useState<EmergencyFundLedgerRowDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dialog, setDialog] = useState<null | "add" | "use" | "plan">(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    api.expenses.categories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    let active = true;
    setError(null);
    Promise.all([api.emergencyFund.overview(), api.emergencyFund.ledger()])
      .then(([o, l]) => {
        if (!active) return;
        setOverview(o);
        setLedger(l);
      })
      .catch((err) => active && setError(errText(err, "Could not load your emergency fund.")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [version]);

  const onDelete = async (id: string) => {
    setError(null);
    try {
      await api.emergencyFund.remove(id);
      setConfirmDeleteId(null);
      setNotice("Entry deleted.");
      emitFinancialChange("emergency");
    } catch (err) {
      // The server refuses a delete that would leave the fund negative; its message says what to fix first.
      setError(errText(err, "Could not delete this entry."));
      setConfirmDeleteId(null);
    }
  };

  const o = overview;
  const coverage = o?.coverage.months ?? null;
  const lowCoverage = coverage !== null && Number(coverage) < LOW_COVERAGE_MONTHS;
  const hasTarget = o?.target.amount != null;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Emergency fund</h1>
          <p className="text-sm text-ink-soft">Cash set aside for the unexpected — kept apart from your spending and your investments.</p>
        </div>
        <div className="fixed bottom-5 right-5 z-40 flex gap-2 sm:static">
          <Button onClick={() => setDialog("add")} className="rounded-full px-5 py-3 shadow-popover sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card">
            + Add money
          </Button>
          <Button variant="secondary" onClick={() => setDialog("use")} className="rounded-full bg-surface px-5 py-3 shadow-popover sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card">
            − Use money
          </Button>
        </div>
      </div>

      {notice && (
        <p role="status" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}

      {loading && !o ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : o ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="In your fund" value={formatINR(o.balance)} basis="ACTUAL" sub={o.entryCount === 0 ? "nothing added yet" : undefined} />
            <Stat
              label="Target"
              value={o.target.amount ? formatINR(o.target.amount) : "Not set"}
              basis="TARGET"
              sub={
                o.target.mode === "MONTHS"
                  ? o.target.needsExpenseHistory
                    ? `${o.target.months} months of essential expenses — needs a few months of spending history`
                    : `${o.target.months} months of essential expenses`
                  : o.target.mode === "AMOUNT"
                    ? "a fixed amount"
                    : "set one under “Target and plan”"
              }
            />
            <Stat label="Progress" basis="ACTUAL" sub={o.progress.reached ? "Target reached" : o.progress.remaining ? `${formatINR(o.progress.remaining)} to go` : "no target set"}>
              <p className="money mt-2 text-xl font-semibold text-ink">{o.progress.percent !== null ? `${o.progress.percent}%` : "—"}</p>
              <div className="mt-2">
                <ProgressBar percent={o.progress.percent} label="Progress towards your emergency fund target" />
              </div>
            </Stat>
            <Stat
              label="Months covered"
              basis="ACTUAL"
              sub={
                coverage === null
                  ? "needs a few months of spending history"
                  : lowCoverage
                    ? `Less than ${LOW_COVERAGE_MONTHS} months of essential expenses covered`
                    : `of essential expenses (about ${formatINR(o.coverage.avgMonthlyEssentialExpenses)} a month)`
              }
            >
              <p className={`money mt-2 text-xl font-semibold ${lowCoverage ? "text-marigold-600" : "text-ink"}`}>{coverage === null ? "—" : `${Number(coverage).toFixed(2)} months`}</p>
            </Stat>
          </div>

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label="Planned each month" value={o.plan.monthlyContribution ? formatINR(o.plan.monthlyContribution) : "—"} basis="ESTIMATED" sub={o.plan.monthlyContribution ? "your plan" : "optional — set under “Target and plan”"} />
            <Stat label="Added this year" value={formatINR(o.totals.contributedThisYear)} basis="ACTUAL" sub={`${formatINR(o.totals.contributedThisMonth)} this month`} />
            <Stat label="Total added" value={formatINR(o.totals.contributions)} basis="ACTUAL" sub={o.last.contribution ? `last on ${formatDay(o.last.contribution.date)}: ${formatINR(o.last.contribution.amount)}` : "none yet"} />
            <Stat label="Total used" value={formatINR(o.totals.withdrawals)} basis="ACTUAL" sub={o.last.withdrawal ? `last on ${formatDay(o.last.withdrawal.date)}: ${formatINR(o.last.withdrawal.amount)}` : "none yet"} />
          </div>

          <Card
            eyebrow="Planning calculation"
            title="Target and plan"
            action={
              <Button size="sm" variant="secondary" onClick={() => setDialog("plan")}>
                {hasTarget || o.target.mode ? "Edit" : "Set a target"}
              </Button>
            }
          >
            {!o.target.mode ? (
              <p className="text-sm text-ink-faint">Choose a target — a number of months of essential expenses, or a fixed amount — to see your progress and what it would take to get there.</p>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2 text-ink-soft">
                  <BasisTag basis="ESTIMATED" />
                  {o.plan.targetDate ? <>To reach {o.target.amount ? formatINR(o.target.amount) : "your target"} by {formatDay(o.plan.targetDate)}:</> : "Set a date to see what it would take each month."}
                </p>
                {o.plan.requiredMonthly !== null && (
                  <p className="text-ink">
                    {Number(o.plan.requiredMonthly) === 0 ? (
                      "You have already reached it."
                    ) : (
                      <>
                        About <span className="money font-medium">{formatINR(o.plan.requiredMonthly)}</span> a month
                        {o.plan.requiredWeekly && (
                          <>
                            {" "}
                            (or <span className="money">{formatINR(o.plan.requiredWeekly)}</span> a week)
                          </>
                        )}
                        .
                      </>
                    )}
                  </p>
                )}
                {o.plan.targetDate && o.plan.requiredMonthly === null && o.progress.remaining && Number(o.progress.remaining) > 0 && (
                  <p className="text-ink-faint">That date is today or has passed, so there is no time left to plan with. Pick a later date.</p>
                )}
                {o.plan.monthlyContribution && o.plan.monthsToTargetAtPlan !== null && o.plan.monthsToTargetAtPlan > 0 && (
                  <p className="text-ink">
                    At {formatINR(o.plan.monthlyContribution)} a month you would reach it in about <span className="font-medium">{o.plan.monthsToTargetAtPlan} month{o.plan.monthsToTargetAtPlan === 1 ? "" : "s"}</span>
                    {o.plan.estimatedFinishDate ? ` (around ${formatDay(o.plan.estimatedFinishDate)})` : ""}.
                  </p>
                )}
                <p className="text-xs text-ink-faint">A planning calculation from your own numbers — not a recommendation.</p>
              </div>
            )}
          </Card>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card eyebrow="Last 12 months" title="Balance over time">
              <BalanceTrendChart overview={o} />
            </Card>
            <Card eyebrow="Last 12 months" title="Added vs used">
              <ContributionVsUseChart overview={o} />
            </Card>
          </div>

          <Card title="History" action={<span className="text-xs text-ink-faint">{ledger.length} entr{ledger.length === 1 ? "y" : "ies"}</span>}>
            {ledger.length === 0 ? (
              <p className="text-sm text-ink-faint">Nothing here yet. Use “+ Add money” to start your fund.</p>
            ) : (
              <ul>
                {ledger.map((row, i) => (
                  <li key={row.id} className={`py-3 text-sm ${i !== ledger.length - 1 ? "ledger-rule" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-ink">
                          <Badge tone={Number(row.effect) >= 0 ? "success" : "warning"}>{TYPE_LABEL[row.type]}</Badge>
                          {row.reason ?? ""}
                        </p>
                        <p className="text-xs text-ink-faint">
                          {formatDay(row.occurredAt)}
                          {row.notes ? ` · ${row.notes}` : ""}
                        </p>
                      </div>
                      <div className="flex items-center gap-4">
                        <div className="text-right">
                          <p className={`money ${Number(row.effect) >= 0 ? "text-gain" : "text-ink"}`}>{signedMoney(row.effect)}</p>
                          <p className="text-xs text-ink-faint">balance {formatINR(row.balanceAfter)}</p>
                        </div>
                        {confirmDeleteId === row.id ? (
                          <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                            <span className="text-ink-soft">Delete this entry?</span>
                            <button type="button" onClick={() => onDelete(row.id)} className="font-medium text-loss hover:underline">
                              Delete
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmDeleteId(row.id)} className="text-xs text-ink-faint hover:text-loss" aria-label={`Delete ${TYPE_LABEL[row.type]} of ${formatINR(row.amount)} on ${formatDay(row.occurredAt)}`}>
                            Remove
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </>
      ) : null}

      <AddMoneyDialog open={dialog === "add"} onClose={() => setDialog(null)} onSaved={setNotice} />
      <UseMoneyDialog open={dialog === "use"} onClose={() => setDialog(null)} balance={o?.balance ?? null} categories={categories} onSaved={setNotice} />
      <PlanDialog open={dialog === "plan"} overview={o} onClose={() => setDialog(null)} onSaved={setNotice} />
    </div>
  );
}
