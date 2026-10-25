"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { CategoryDTO, GoalFundLedgerRowDTO, GoalFundOverviewDTO, GoalFundSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { BasisTag, FactBasis } from "@/components/ui/BasisTag";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { AddMoneyDialog, MoveMoneyDialog, PlanDialog, UseMoneyDialog } from "@/components/goals/GoalFundDialogs";
import { BalanceTrendChart, ContributionVsUseChart } from "@/components/goals/GoalFundCharts";
import { NewGoalDialog } from "@/components/goals/NewGoalDialog";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { goalTypeLabel } from "@/lib/goal-types";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

// MONEY → GOALS. One page for every goal: the selector lists the user's goals (whatever types they have, and
// whatever they create later), and the detail below is the emergency-fund experience for the selected one.
// Nothing here is registered per goal — labels, spend options and which figures apply come from the API.

// A common rule of thumb used only to flag low cover in amber; it is not advice, and a target the user
// has set themselves is what progress is measured against.
const LOW_COVERAGE_MONTHS = 3;

const TYPE_LABEL: Record<GoalFundLedgerRowDTO["type"], string> = {
  ALLOCATE: "Added",
  WITHDRAWAL: "Used",
  RELEASE: "Released",
  ADJUSTMENT: "Adjustment",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
};

// Entries that were created by the system rather than typed in get a plainer name.
function rowLabel(row: GoalFundLedgerRowDTO): string {
  if (row.origin === "REALLOCATION") return row.type === "TRANSFER_IN" ? "Moved in" : "Moved out";
  if (row.origin === "OPENING_BALANCE") return "Opening balance";
  if (row.origin === "GOAL_CLOSED") return "Returned to cash";
  return TYPE_LABEL[row.type];
}

const STATUS: Record<GoalFundOverviewDTO["status"]["probabilityOfSuccess"], { tone: "success" | "warning" | "critical"; label: string }> = {
  ON_TRACK: { tone: "success", label: "On track" },
  AT_RISK: { tone: "warning", label: "At risk" },
  OFF_TRACK: { tone: "critical", label: "Off track" },
};
const STATUS_TOOLTIP =
  "Based on your contribution pace versus the pace needed to hit this goal's target date — a simple comparison, not a statistically modeled probability.";

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

export default function MoneyGoalsPage() {
  // useSearchParams needs a Suspense boundary for the production build.
  return (
    <Suspense fallback={<p className="text-sm text-ink-faint">Loading…</p>}>
      <GoalsManager />
    </Suspense>
  );
}

function GoalsManager() {
  const router = useRouter();
  const params = useSearchParams();
  const wanted = params.get("goal");
  const version = useFinancialVersion(["goal", "emergency", "expense", "investment"]);

  const [funds, setFunds] = useState<GoalFundSummaryDTO[] | null>(null);
  const [showClosed, setShowClosed] = useState(false);
  const [overview, setOverview] = useState<GoalFundOverviewDTO | null>(null);
  const [ledger, setLedger] = useState<GoalFundLedgerRowDTO[]>([]);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dialog, setDialog] = useState<null | "add" | "use" | "move" | "plan" | "new">(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);

  useEffect(() => {
    api.expenses.categories().then(setCategories).catch(() => setCategories([]));
  }, []);

  // The selector: every goal, active first.
  useEffect(() => {
    let active = true;
    api.goalFunds
      .list(showClosed ? { archived: true } : {})
      .then((list) => active && setFunds(list))
      .catch((err) => {
        if (!active) return;
        setFunds((f) => f ?? []);
        setError(errText(err, "Could not load your goals."));
      });
    return () => {
      active = false;
    };
  }, [version, showClosed]);

  const selected = useMemo(() => {
    if (!funds || funds.length === 0) return null;
    return funds.find((f) => f.id === wanted) ?? (wanted === "emergency" ? funds.find((f) => f.backing === "RESERVE") : undefined) ?? funds[0];
  }, [funds, wanted]);
  const selectedId = selected?.id ?? null;

  // The detail for the selected goal.
  useEffect(() => {
    if (!selectedId) {
      setOverview(null);
      setLedger([]);
      return;
    }
    let active = true;
    setLoadingDetail(true);
    setError(null);
    Promise.all([api.goalFunds.overview(selectedId), api.goalFunds.ledger(selectedId)])
      .then(([o, l]) => {
        if (!active) return;
        setOverview(o);
        setLedger(l);
      })
      .catch((err) => active && setError(errText(err, "Could not load this goal.")))
      .finally(() => active && setLoadingDetail(false));
    return () => {
      active = false;
    };
  }, [selectedId, version]);

  const select = useCallback(
    (id: string) => {
      setNotice(null);
      setConfirmDeleteId(null);
      setConfirmClose(false);
      router.replace(`/money/goals?goal=${id}`, { scroll: false });
    },
    [router],
  );

  // A different goal's detail must never show under the newly selected goal's name.
  const o = overview && overview.goal.id === selectedId ? overview : null;
  const dialogGoal = o ? { id: o.goal.id, name: o.goal.name, backing: o.goal.backing } : null;
  const archived = o?.goal.archived ?? false;

  const onDelete = async (entryId: string) => {
    if (!o) return;
    setError(null);
    try {
      const r = await api.goalFunds.removeEntry(o.goal.id, entryId);
      setConfirmDeleteId(null);
      setNotice(r.keptExpenseId ? "Entry deleted. The expense it recorded was kept — remove it from Expenses if it was a mistake." : "Entry deleted.");
      emitFinancialChange("goal");
      if (o.goal.backing === "RESERVE") emitFinancialChange("emergency");
    } catch (err) {
      // The server refuses a delete that would leave a balance negative; its message says what to fix first.
      setError(errText(err, "Could not delete this entry."));
      setConfirmDeleteId(null);
    }
  };

  const onClose = async () => {
    if (!o) return;
    setError(null);
    try {
      const r = await api.goals.remove(o.goal.id);
      setConfirmClose(false);
      setNotice(
        r.archived
          ? `${o.goal.name} was closed${r.releasedAmount && Number(r.releasedAmount) > 0 ? ` and ${formatINR(r.releasedAmount)} returned to your cash` : ""}. You can restore it from “Show closed goals”.`
          : `${o.goal.name} was deleted.`,
      );
      emitFinancialChange("goal");
      if (o.goal.backing === "RESERVE") emitFinancialChange("emergency");
      router.replace("/money/goals", { scroll: false });
    } catch (err) {
      setError(errText(err, "Could not close this goal."));
      setConfirmClose(false);
    }
  };

  const onRestore = async () => {
    if (!o) return;
    setError(null);
    try {
      await api.goals.restore(o.goal.id);
      setNotice(`${o.goal.name} was restored.`);
      emitFinancialChange("goal");
    } catch (err) {
      setError(errText(err, "Could not restore this goal."));
    }
  };

  const coverage = o?.coverage?.months ?? null;
  const lowCoverage = coverage !== null && Number(coverage) < LOW_COVERAGE_MONTHS;
  const hasTarget = o?.target.amount != null;
  const hasEmergency = !!funds?.some((f) => f.backing === "RESERVE" && !f.archived);
  const others = (funds ?? []).filter((f) => !f.archived && f.id !== selectedId);
  const status = o ? STATUS[o.status.probabilityOfSuccess] : null;

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">{o ? o.goal.name : "Goals"}</h1>
          <p className="text-sm text-ink-soft">
            {!o
              ? "Everything you are saving toward — add money, use it, move it between goals and see your plan."
              : o.goal.backing === "RESERVE"
                ? "Cash set aside for the unexpected — kept apart from your spending and your investments."
                : `${o.rules.typeLabel} goal — money set aside for it, kept apart from your spending.`}
          </p>
        </div>
        {o && !archived && (
          <div className="fixed bottom-5 right-5 z-40 flex gap-2 sm:static">
            <Button onClick={() => setDialog("add")} className="rounded-full px-5 py-3 shadow-popover sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card">
              + Add money
            </Button>
            <Button variant="secondary" onClick={() => setDialog("use")} className="rounded-full bg-surface px-5 py-3 shadow-popover sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card">
              − Use money
            </Button>
            <Button variant="secondary" onClick={() => setDialog("move")} className="hidden bg-surface sm:inline-flex">
              ⇄ Move money
            </Button>
          </div>
        )}
      </div>

      <nav aria-label="Your goals" className="space-y-3">
        <ul className="flex gap-3 overflow-x-auto pb-1">
          {(funds ?? []).map((f) => {
            const on = f.id === selectedId;
            return (
              <li key={f.id} className="shrink-0">
                <button
                  type="button"
                  onClick={() => select(f.id)}
                  aria-current={on ? "true" : undefined}
                  className={`w-52 rounded-lg border p-3 text-left transition-colors ${on ? "border-marigold-500 bg-marigold-50" : "border-line bg-surface hover:bg-surface-muted"} ${f.archived ? "opacity-70" : ""}`}
                >
                  <span className="block truncate text-sm font-medium text-ink">{f.name}</span>
                  <span className="block text-[11px] text-ink-faint">
                    {goalTypeLabel(f.type)}
                    {f.archived ? " · closed" : ""}
                  </span>
                  <span className="money mt-1 block text-sm text-ink">{formatINR(f.totalFunded)}</span>
                  <span className="block text-[11px] text-ink-faint">
                    {f.targetAmount === null ? "no target" : f.reached ? "fully funded" : `${f.progressPercent ?? 0}% of ${formatINR(f.targetAmount)}`}
                  </span>
                </button>
              </li>
            );
          })}
          <li className="shrink-0">
            <button
              type="button"
              onClick={() => setDialog("new")}
              className="flex h-full min-h-[5.5rem] w-40 items-center justify-center rounded-lg border border-dashed border-line px-3 text-sm text-ink-soft hover:border-marigold-500 hover:text-ink"
            >
              + New goal
            </button>
          </li>
        </ul>
        <label className="flex items-center gap-2 text-xs text-ink-faint">
          <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />
          Show closed goals
        </label>
      </nav>

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

      {funds === null ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : funds.length === 0 ? (
        <Card title="No goals yet">
          <p className="text-sm text-ink-soft">Create a goal — an emergency fund, a house, a holiday — and this page becomes its home: balance, history, target and plan.</p>
          <div className="mt-3">
            <Button onClick={() => setDialog("new")}>Create your first goal</Button>
          </div>
        </Card>
      ) : loadingDetail && !o ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : o ? (
        <>
          {archived && (
            <div role="note" className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
              <span>This goal is closed. Its history is kept, and no money is set aside for it.</span>
              <Button size="sm" variant="secondary" onClick={onRestore}>
                Restore goal
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Stat label={o.rules.balanceLabel} value={formatINR(o.balance)} basis="ACTUAL" sub={o.entryCount === 0 ? "nothing added yet" : undefined} />
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
                <ProgressBar percent={o.progress.percent} label={`Progress towards your ${o.goal.name} target`} />
              </div>
            </Stat>
            {o.coverage ? (
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
            ) : (
              <Stat
                label="Still to save"
                value={hasTarget ? formatINR(o.progress.remaining ?? "0") : "—"}
                basis="ACTUAL"
                sub={!hasTarget ? "no target set" : o.progress.reached ? "fully funded — nothing left to save" : "shortfall against your target"}
              />
            )}
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
              !archived && (
                <Button size="sm" variant="secondary" onClick={() => setDialog("plan")}>
                  {hasTarget || o.target.mode ? "Edit" : "Set a target"}
                </Button>
              )
            }
          >
            {!o.target.mode ? (
              <p className="text-sm text-ink-faint">
                {o.rules.supportsMonthsTarget
                  ? "Choose a target — a number of months of essential expenses, or a fixed amount — to see your progress and what it would take to get there."
                  : "Choose a target amount to see your progress and what it would take to get there."}
              </p>
            ) : (
              <div className="space-y-2 text-sm">
                <p className="flex flex-wrap items-center gap-2 text-ink-soft">
                  <BasisTag basis="ESTIMATED" />
                  {status && (
                    <span title={STATUS_TOOLTIP}>
                      <Badge tone={status.tone}>{status.label}</Badge>
                    </span>
                  )}
                  {o.goal.hasTargetDate && o.plan.targetDate ? (
                    <>To reach {o.target.amount ? formatINR(o.target.amount) : "your target"} by {formatDay(o.plan.targetDate)}:</>
                  ) : (
                    "Set a date to see what it would take each month."
                  )}
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
                {o.goal.hasTargetDate && o.plan.targetDate && o.plan.requiredMonthly === null && o.progress.remaining && Number(o.progress.remaining) > 0 && (
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

          {Number(o.funding.linkedInvestmentValue) > 0 && (
            <Card eyebrow="Counted towards the target" title="Where the money is">
              <dl className="grid gap-3 text-sm sm:grid-cols-3">
                <div>
                  <dt className="stat-label">Set aside in cash</dt>
                  <dd className="money mt-1 text-ink">{formatINR(o.funding.cashBalance)}</dd>
                </div>
                <div>
                  <dt className="stat-label">Linked investments</dt>
                  <dd className="money mt-1 text-ink">{formatINR(o.funding.linkedInvestmentValue)}</dd>
                </div>
                <div>
                  <dt className="stat-label">Total funded</dt>
                  <dd className="money mt-1 font-medium text-ink">{formatINR(o.funding.totalFunded)}</dd>
                </div>
              </dl>
              <ul className="mt-3 space-y-1 text-xs text-ink-soft">
                {o.funding.linkedInvestments.map((inv) => (
                  <li key={inv.id} className="flex justify-between gap-3">
                    <span>{inv.name}</span>
                    <span className="money">{formatINR(inv.currentValue)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-ink-faint">An investment can back only one goal. Its value is counted here, not added to your cash.</p>
            </Card>
          )}

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
              <p className="text-sm text-ink-faint">Nothing here yet. Use “+ Add money” to start.</p>
            ) : (
              <ul>
                {ledger.map((row, i) => (
                  <li key={row.id} className={`py-3 text-sm ${i !== ledger.length - 1 ? "ledger-rule" : ""}`}>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-ink">
                          <Badge tone={Number(row.effect) >= 0 ? "success" : "warning"}>{rowLabel(row)}</Badge>
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
                        {archived ? null : confirmDeleteId === row.id ? (
                          <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                            <span className="text-ink-soft">{row.origin === "REALLOCATION" ? "Undo this move? Both goals are put back." : "Delete this entry?"}</span>
                            <button type="button" onClick={() => onDelete(row.id)} className="font-medium text-loss hover:underline">
                              Delete
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                              Keep
                            </button>
                          </span>
                        ) : (
                          <button type="button" onClick={() => setConfirmDeleteId(row.id)} className="text-xs text-ink-faint hover:text-loss" aria-label={`Delete ${rowLabel(row)} of ${formatINR(row.amount)} on ${formatDay(row.occurredAt)}`}>
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

          {!archived && (
            <Card title="Manage this goal">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <Link href="/goals" className="text-marigold-600 hover:underline">
                  Edit name, type and date on the Goals overview
                </Link>
                {confirmClose ? (
                  <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm close goal">
                    <span className="text-ink-soft">
                      {o.entryCount > 0
                        ? "This goal has history, so it will be closed (you can restore it) and any money set aside returns to your cash."
                        : "This goal has no history and will be deleted."}
                    </span>
                    <button type="button" onClick={onClose} className="font-medium text-loss hover:underline">
                      {o.entryCount > 0 ? "Close goal" : "Delete goal"}
                    </button>
                    <button type="button" onClick={() => setConfirmClose(false)} className="text-ink-faint hover:underline">
                      Keep
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setConfirmClose(true)} className="text-ink-faint hover:text-loss">
                    Close this goal
                  </button>
                )}
              </div>
            </Card>
          )}
        </>
      ) : null}

      {dialogGoal && o && (
        <>
          <AddMoneyDialog open={dialog === "add"} goal={dialogGoal} rules={o.rules} onClose={() => setDialog(null)} onSaved={setNotice} />
          <UseMoneyDialog open={dialog === "use"} goal={dialogGoal} rules={o.rules} balance={o.balance} categories={categories} onClose={() => setDialog(null)} onSaved={setNotice} />
          <MoveMoneyDialog open={dialog === "move"} goal={dialogGoal} others={others} balance={o.balance} onClose={() => setDialog(null)} onSaved={setNotice} />
          <PlanDialog open={dialog === "plan"} goal={dialogGoal} rules={o.rules} overview={o} onClose={() => setDialog(null)} onSaved={setNotice} />
        </>
      )}
      <NewGoalDialog
        open={dialog === "new"}
        hasEmergencyFund={hasEmergency}
        onClose={() => setDialog(null)}
        onCreated={(g) => {
          setNotice(`${g.name} created.`);
          select(g.id);
        }}
      />
    </div>
  );
}
