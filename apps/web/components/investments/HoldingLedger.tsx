"use client";

import { useCallback, useEffect, useState } from "react";
import type { InvestmentCashflowDTO, InvestmentCashflowType, InvestmentDTO, InvestmentMetricsDTO, InvestmentValuationDTO, SipScheduleSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { BasisTag } from "@/components/ui/BasisTag";
import { CashflowDialog, CASHFLOW_TYPES, SaleDialog, ScheduleDialog, ValuationDialog } from "@/components/investments/LedgerDialogs";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

type Tab = "summary" | "ledger" | "values" | "schedule";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "summary", label: "Summary" },
  { value: "ledger", label: "Transactions" },
  { value: "values", label: "Value history" },
  { value: "schedule", label: "Recurring" },
];

const TYPE_LABEL = Object.fromEntries(CASHFLOW_TYPES.map((t) => [t.value, t.label])) as Record<InvestmentCashflowType, string>;
TYPE_LABEL.SALE = "Sale proceeds";

// How an entry moves money relative to YOUR cash, so the list never relies on colour alone.
const MONEY_OUT_OF_CASH = new Set<InvestmentCashflowType>(["CONTRIBUTION", "FEE", "TRANSFER_IN"]);
const MONEY_INTO_CASH = new Set<InvestmentCashflowType>(["WITHDRAWAL", "SALE", "DIVIDEND", "TRANSFER_OUT"]);

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);
// The API returns a ratio (0.05 = 5%); this is only presentation.
const ratioPercent = (r: string | null) => (r === null ? "—" : `${(Number(r) * 100).toFixed(1)}%`);

function Kpi({ label, value, tone, sub }: { label: string; value: string; tone?: "gain" | "loss"; sub?: string }) {
  return (
    <div className="rounded-md border border-line p-3">
      <dt className="stat-label">{label}</dt>
      <dd className={`money mt-1 text-sm ${tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : "text-ink"}`}>{value}</dd>
      {sub && <dd className="mt-0.5 text-[11px] text-ink-faint">{sub}</dd>}
    </div>
  );
}

const signed = (v: string) => {
  const n = Number(v);
  return `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatINR(Math.abs(n))}`;
};
const toneOf = (v: string): "gain" | "loss" | undefined => (Number(v) > 0 ? "gain" : Number(v) < 0 ? "loss" : undefined);

// Level 3-4 for ONE holding: what has gone in and out (the ledger), what it was worth when (value
// history), and how it is topped up (the recurring schedule). Loaded only when the holding is opened.
export function HoldingLedger({ investment, onChanged }: { investment: InvestmentDTO; onChanged: () => void }) {
  const version = useFinancialVersion(["investment"]);
  const [tab, setTab] = useState<Tab>("summary");
  const [metrics, setMetrics] = useState<InvestmentMetricsDTO | null>(null);
  const [cashflows, setCashflows] = useState<InvestmentCashflowDTO[] | null>(null);
  const [valuations, setValuations] = useState<InvestmentValuationDTO[] | null>(null);
  const [schedule, setSchedule] = useState<SipScheduleSummaryDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [dialog, setDialog] = useState<null | "cashflow" | "value" | "schedule" | "sale">(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const id = investment.id;
  const load = useCallback(() => {
    let active = true;
    setError(null);
    Promise.all([api.investments.metrics(id), api.investments.cashflows(id), api.investments.valuations(id), api.investments.sipSchedule(id)])
      .then(([m, c, v, s]) => {
        if (!active) return;
        setMetrics(m);
        setCashflows(c);
        setValuations(v);
        setSchedule(s);
      })
      .catch((err) => active && setError(errText(err, "Could not load this holding's history.")));
    return () => {
      active = false;
    };
  }, [id]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [load, version]);

  const saved = (message: string) => {
    setNotice(message);
    onChanged();
  };

  const onDeleteCashflow = async (cf: InvestmentCashflowDTO) => {
    setError(null);
    try {
      await api.investments.removeCashflow(id, cf.id);
      setConfirmDeleteId(null);
      setNotice("Entry deleted.");
      emitFinancialChange("investment");
      onChanged();
    } catch (err) {
      setError(errText(err, "Could not delete this entry."));
    }
  };

  const onGenerate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const res = await api.investments.generateSip(id);
      setNotice(res.created.length ? `Created ${res.created.length} due contribution${res.created.length === 1 ? "" : "s"}.` : "Nothing is due right now — you are up to date.");
      emitFinancialChange("investment");
      onChanged();
    } catch (err) {
      setError(errText(err, "Could not create the due contributions."));
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="mt-3 rounded-md border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div role="tablist" aria-label={`${investment.name} details`} className="flex gap-1 overflow-x-auto border-b border-line pb-px">
          {TABS.map((t) => (
            <button
              key={t.value}
              role="tab"
              type="button"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.value ? "border-marigold-500 font-medium text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setDialog("cashflow")}>
            + Transaction
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog("value")}>
            Update value
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setDialog("sale")}>
            Record sale
          </Button>
        </div>
      </div>

      {notice && (
        <p role="status" className="mb-3 rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="mb-3 text-sm text-loss">
          {error}
        </p>
      )}

      <div role="tabpanel">
        {tab === "summary" &&
          (!metrics ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-xs text-ink-faint">
                <BasisTag basis="ACTUAL" />
                <span>{metrics.valuationSource === "VALUATION" ? "Using your latest recorded value." : "No dated value recorded yet — using the value saved on the holding."}</span>
              </div>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Kpi label="You put in" value={formatINR(metrics.grossContributions)} />
                <Kpi label="Employer added" value={formatINR(metrics.employerContributions)} />
                <Kpi label="Taken out" value={formatINR(metrics.withdrawals)} />
                <Kpi label="Net put in" value={formatINR(metrics.netContributions)} />
                <Kpi label="Cost basis" value={formatINR(metrics.costBasis)} />
                <Kpi label="Worth now" value={formatINR(metrics.currentValue)} />
                <Kpi label="Unrealised gain" value={signed(metrics.unrealizedGain)} tone={toneOf(metrics.unrealizedGain)} />
                <Kpi label="Realised gain" value={signed(metrics.realizedGain)} tone={toneOf(metrics.realizedGain)} />
                <Kpi label="Dividends" value={formatINR(metrics.dividends)} />
                <Kpi label="Fees" value={formatINR(metrics.fees)} />
                <Kpi label="Total return" value={signed(metrics.totalReturn)} tone={toneOf(metrics.totalReturn)} />
                <Kpi label="Return" value={ratioPercent(metrics.returnRatio)} tone={toneOf(metrics.totalReturn)} />
              </dl>
              {Number(metrics.grossContributions) === 0 && (
                <p className="text-xs text-ink-faint">No contributions are recorded for this holding yet, so the return above is not meaningful. Add the money you put in as transactions.</p>
              )}
            </div>
          ))}

        {tab === "ledger" &&
          (!cashflows ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : cashflows.length === 0 ? (
            <p className="text-sm text-ink-faint">No transactions yet. Record contributions, withdrawals, dividends or fees with “+ Transaction”.</p>
          ) : (
            <ul>
              {cashflows.map((cf, i) => (
                <li key={cf.id} className={`py-2 text-sm ${i !== cashflows.length - 1 ? "ledger-rule" : ""}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-ink">
                        {TYPE_LABEL[cf.type]}
                        {cf.origin === "RECURRING" && (
                          <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">from schedule</span>
                        )}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {formatDay(cf.occurredAt)}
                        {cf.notes ? ` · ${cf.notes}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-right">
                        <span className="money block text-ink">{formatINR(cf.amount)}</span>
                        <span className="block text-[11px] text-ink-faint">
                          {MONEY_OUT_OF_CASH.has(cf.type) ? "from your cash" : MONEY_INTO_CASH.has(cf.type) ? "to your cash" : "inside the investment"}
                        </span>
                      </span>
                      {confirmDeleteId === cf.id ? (
                        <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                          <span className="text-ink-soft">
                            {cf.origin === "RECURRING" ? "This was created by the schedule and would be created again. Delete anyway?" : "Delete this entry?"}
                          </span>
                          <button type="button" onClick={() => onDeleteCashflow(cf)} className="font-medium text-loss hover:underline">
                            Delete
                          </button>
                          <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                            Keep
                          </button>
                        </span>
                      ) : (
                        <button type="button" onClick={() => setConfirmDeleteId(cf.id)} className="text-xs text-ink-faint hover:text-loss" aria-label={`Delete ${TYPE_LABEL[cf.type]} of ${formatINR(cf.amount)}`}>
                          Remove
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          ))}

        {tab === "values" &&
          (!valuations ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : valuations.length === 0 ? (
            <p className="text-sm text-ink-faint">No dated values yet. Use “Update value” to record what this is worth today and build its history.</p>
          ) : (
            <ul>
              {valuations.map((v, i) => (
                <li key={v.id} className={`flex items-center justify-between py-2 text-sm ${i !== valuations.length - 1 ? "ledger-rule" : ""}`}>
                  <span className="text-ink-soft">{formatDay(v.valuedAt)}</span>
                  <span className="money text-ink">{formatINR(v.value)}</span>
                </li>
              ))}
            </ul>
          ))}

        {tab === "schedule" &&
          (!schedule ? (
            <p className="text-sm text-ink-faint">Loading…</p>
          ) : !schedule.amountPerPeriod ? (
            <div className="space-y-3">
              <p className="text-sm text-ink-faint">No recurring contribution is set up. A schedule records each contribution automatically when it falls due.</p>
              <Button size="sm" onClick={() => setDialog("schedule")}>
                Set up a schedule
              </Button>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                {formatINR(schedule.amountPerPeriod)} · {schedule.frequency.toLowerCase().replace("biweekly", "every 2 weeks")}
                <Badge tone={schedule.active ? "success" : "info"}>{schedule.active ? "Active" : "Paused"}</Badge>
              </p>
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Kpi label="Next contribution" value={schedule.nextContributionDate ? formatDay(schedule.nextContributionDate) : "—"} />
                <Kpi label="Monthly equivalent" value={schedule.monthlyEquivalent ? formatINR(schedule.monthlyEquivalent) : "—"} sub="planned" />
                <Kpi label="Per year" value={schedule.annualContribution ? formatINR(schedule.annualContribution) : "—"} sub="planned" />
                <Kpi label="Expected return" value={schedule.expectedAnnualReturn ? `${schedule.expectedAnnualReturn}% a year` : "not set"} sub="assumption" />
                <Kpi label="Recorded so far" value={`${schedule.actualCount} · ${formatINR(schedule.actualAmount)}`} />
                <Kpi label="Due so far" value={String(schedule.dueSoFarCount)} />
                <Kpi label="Planned in total" value={schedule.plannedCount !== null ? `${schedule.plannedCount}${schedule.plannedTotal ? ` · ${formatINR(schedule.plannedTotal)}` : ""}` : "open-ended"} />
                <Kpi label="Remaining" value={schedule.remainingCount !== null ? String(schedule.remainingCount) : "—"} />
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={() => setDialog("schedule")}>
                  Edit schedule
                </Button>
                {schedule.active && (
                  <Button size="sm" variant="secondary" onClick={onGenerate} disabled={generating}>
                    {generating ? "Working…" : "Create due contributions now"}
                  </Button>
                )}
              </div>
            </div>
          ))}
      </div>

      <CashflowDialog investment={dialog === "cashflow" ? investment : null} onClose={() => setDialog(null)} onSaved={saved} />
      <ValuationDialog investment={dialog === "value" ? investment : null} onClose={() => setDialog(null)} onSaved={saved} />
      <ScheduleDialog investment={dialog === "schedule" ? investment : null} schedule={schedule} onClose={() => setDialog(null)} onSaved={saved} />
      <SaleDialog investment={dialog === "sale" ? investment : null} onClose={() => setDialog(null)} onSaved={saved} />
    </div>
  );
}
