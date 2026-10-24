"use client";

import { useCallback, useEffect, useState } from "react";
import type { InvestmentAnalyticsDTO, InvestmentDTO, InvestmentPortfolioDTO, InvestmentSummaryDTO, PortfolioHoldingDTO, PortfolioProjectionDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";
import { RebalancePanel } from "@/components/investments/RebalancePanel";
import { PortfolioOverview } from "@/components/investments/PortfolioOverview";
import { AllocationPanel, ContributionTrendChart, GainTrendChart, InvestedVsCurrentChart, ValueTrendChart } from "@/components/investments/InvestmentCharts";
import { ProjectionPanel } from "@/components/investments/ProjectionPanel";
import { HoldingLedger } from "@/components/investments/HoldingLedger";
import { SipManager, SipStatusBadge } from "@/components/investments/SipManager";
import { TransactionsPanel } from "@/components/investments/TransactionsPanel";
import { AddHoldingDialog, INVESTMENT_TYPES, LIQUIDITY_LEVELS, RISK_LEVELS } from "@/components/investments/AddHoldingDialog";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { formatINR, formatPercent } from "@/lib/format";
import { formatDay } from "@/lib/dates";

const OVERVIEW_PROJECTION_YEARS = 10;
const pretty = (s: string) => s.replace(/_/g, " ").toLowerCase();
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

type FilterKey = "ALL" | "MUTUAL_FUND" | "STOCK" | "ETF" | "SIP" | "ONE_TIME" | "RETIREMENT" | "OTHER";
const FILTERS: Array<{ key: FilterKey; label: string }> = [
  { key: "ALL", label: "All investments" },
  { key: "MUTUAL_FUND", label: "Mutual funds" },
  { key: "STOCK", label: "Stocks" },
  { key: "ETF", label: "ETFs" },
  { key: "SIP", label: "SIPs" },
  { key: "ONE_TIME", label: "One-time" },
  { key: "RETIREMENT", label: "Retirement" },
  { key: "OTHER", label: "Other" },
];
const RETIREMENT = new Set(["EPF", "PPF", "NPS"]);
const MAIN = new Set(["MUTUAL_FUND", "STOCK", "ETF", "EPF", "PPF", "NPS"]);

function matchesFilter(filter: FilterKey, item: InvestmentDTO, p: PortfolioHoldingDTO | undefined): boolean {
  const hasSip = p ? p.sipStatus !== "NONE" : !!item.sipActive;
  switch (filter) {
    case "ALL": return true;
    case "SIP": return hasSip;
    case "ONE_TIME": return !hasSip;
    case "RETIREMENT": return RETIREMENT.has(item.type);
    case "OTHER": return !MAIN.has(item.type);
    default: return item.type === filter;
  }
}

type TabKey = "holdings" | "sips" | "transactions" | "performance" | "planning";
const TABS: Array<{ key: TabKey; label: string }> = [
  { key: "holdings", label: "Holdings" },
  { key: "sips", label: "SIPs" },
  { key: "transactions", label: "Transactions" },
  { key: "performance", label: "Performance" },
  { key: "planning", label: "Planning" },
];

const EDIT_FIELDS: EditField[] = [
  { key: "type", label: "Type", type: "select", options: INVESTMENT_TYPES.map((t) => ({ value: t, label: t })) },
  { key: "name", label: "Name" },
  { key: "currentValue", label: "Current value (₹)", type: "number", money: true },
  { key: "costBasis", label: "Cost basis (₹)", type: "number", money: true },
  { key: "purchaseDate", label: "Purchase date", type: "date" },
  { key: "riskLevel", label: "Risk level", type: "select", options: RISK_LEVELS.map((r) => ({ value: r, label: r })) },
  { key: "liquidity", label: "Liquidity", type: "select", options: LIQUIDITY_LEVELS.map((l) => ({ value: l, label: l })) },
];

export default function InvestmentsPage() {
  const version = useFinancialVersion(["investment"]);
  const [items, setItems] = useState<InvestmentDTO[]>([]);
  const [summary, setSummary] = useState<InvestmentSummaryDTO | null>(null);
  const [analytics, setAnalytics] = useState<InvestmentAnalyticsDTO | null>(null);
  const [portfolio, setPortfolio] = useState<InvestmentPortfolioDTO | null>(null);
  const [filter, setFilter] = useState<FilterKey>("ALL");
  const [tab, setTab] = useState<TabKey>("holdings");
  const [portfolioProjection, setPortfolioProjection] = useState<PortfolioProjectionDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [addOpen, setAddOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // The list and summary are the page's core; analytics (trends, allocation) is supplementary, so its
  // failure leaves the charts empty instead of blocking the holdings.
  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([api.investments.list(), api.investments.summary()])
      .then(([list, s]) => {
        if (!active) return;
        setItems(list);
        setSummary(s);
      })
      .catch((err) => active && setError(errText(err, "Could not load investments.")))
      .finally(() => active && setLoading(false));
    api.investments
      .analytics(12)
      .then((a) => active && setAnalytics(a))
      .catch(() => active && setAnalytics(null));
    // The canonical summary (the same one the Home dashboard reads). Supplementary here: if it fails the
    // holdings still load, and the cards show a dash instead of a made-up number.
    api.investments
      .portfolio()
      .then((p) => active && setPortfolio(p))
      .catch(() => active && setPortfolio(null));
    return () => {
      active = false;
    };
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [load, version]);

  const done = (message: string) => {
    setNotice(message);
    emitFinancialChange("investment");
  };

  const onDelete = async (id: string) => {
    setError(null);
    try {
      await api.investments.remove(id);
      setConfirmDeleteId(null);
      if (expandedId === id) setExpandedId(null);
      setNotice("Holding deleted.");
      emitFinancialChange("investment");
    } catch (err) {
      setError(errText(err, "Could not delete this holding."));
    }
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.investments.update(id, {
      type: values.type as string,
      name: values.name as string,
      currentValue: parseFloat(values.currentValue as string),
      costBasis: parseFloat(values.costBasis as string),
      purchaseDate: new Date(values.purchaseDate as string).toISOString(),
      riskLevel: values.riskLevel as string,
      liquidity: values.liquidity as string,
    });
    setEditingId(null);
    setNotice("Holding updated.");
    emitFinancialChange("investment");
  };

  const byId = new Map((portfolio?.holdings ?? []).map((h) => [h.id, h]));
  const visibleItems = items.filter((i) => matchesFilter(filter, i, byId.get(i.id)));

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Investments</h1>
          <p className="text-sm text-ink-soft">Mutual funds, stocks, EPF/PPF/NPS, gold, real estate and more — what you put in, what it is worth, and where it could go.</p>
        </div>
        <Button onClick={() => setAddOpen(true)} className="fixed bottom-5 right-5 z-40 rounded-full px-5 py-3 shadow-popover sm:static sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card">
          + Add holding
        </Button>
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

      <PortfolioOverview portfolio={portfolio} projection={portfolioProjection} projectionYears={OVERVIEW_PROJECTION_YEARS} />

      <div role="tablist" aria-label="Investment sections" className="flex gap-1 overflow-x-auto border-b border-line pb-px">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            type="button"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === t.key ? "border-marigold-500 font-medium text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "performance" && (
        <div role="tabpanel" className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
          <Card eyebrow="Actual" title="Invested vs current value">
            <InvestedVsCurrentChart items={items} />
          </Card>
          <Card eyebrow="Actual" title="Where your money is">
            {analytics ? <AllocationPanel analytics={analytics} /> : <p className="text-sm text-ink-faint">{loading ? "Loading…" : "Allocation is unavailable right now."}</p>}
          </Card>
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <Card eyebrow="Last 12 months" title="Contributions">
            {analytics ? <ContributionTrendChart analytics={analytics} /> : <p className="text-sm text-ink-faint">{loading ? "Loading…" : "Unavailable."}</p>}
          </Card>
          <Card eyebrow="Last 12 months" title="Portfolio value">
            {analytics ? <ValueTrendChart analytics={analytics} /> : <p className="text-sm text-ink-faint">{loading ? "Loading…" : "Unavailable."}</p>}
          </Card>
          <Card eyebrow="Last 12 months" title="Gain / loss">
            {analytics ? (
              <>
                <GainTrendChart analytics={analytics} />
                {analytics.overview.holdings > analytics.overview.holdingsWithLedger && (
                  <p className="mt-2 text-[11px] text-ink-faint">
                    Based on {analytics.overview.holdingsWithLedger} of {analytics.overview.holdings} holdings — only those with recorded transactions can show a gain trend.
                  </p>
                )}
              </>
            ) : (
              <p className="text-sm text-ink-faint">{loading ? "Loading…" : "Unavailable."}</p>
            )}
          </Card>
        </div>
        </div>
      )}

      {/* Always mounted (just hidden): the projection it computes also feeds the overview cards above. */}
      {(
        <div role="tabpanel" hidden={tab !== "planning"} className="space-y-6">
      <Card eyebrow="Projection" title="What it could become">
          <ProjectionPanel onChange={(_rate, p) => setPortfolioProjection(p)} />
        </Card>

        {summary && <RebalancePanel summary={summary} allTypes={INVESTMENT_TYPES} />}
        </div>
      )}

      {tab === "sips" && (
        <Card title="Recurring investments (SIPs)">
          <SipManager holdings={portfolio?.holdings ?? []} onChanged={done} />
        </Card>
      )}

      {tab === "transactions" && (
        <Card title="Transaction history">
          <TransactionsPanel holdings={portfolio?.holdings ?? []} onChanged={done} />
        </Card>
      )}

      {tab === "holdings" && (
      <Card title="All holdings">
        <div role="group" aria-label="Filter holdings" className="mb-3 flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              aria-pressed={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-full border px-3 py-1 text-xs ${filter === f.key ? "border-marigold-500 bg-marigold-50 font-medium text-ink" : "border-line text-ink-soft hover:border-ink-faint"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        {loading && items.length === 0 ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">No holdings logged yet. Add your first with “+ Add holding”.</p>
        ) : visibleItems.length === 0 ? (
          <p className="text-sm text-ink-faint">No holdings match this filter.</p>
        ) : (
          <ul>
            {visibleItems.map((item, i) => (
              <li key={item.id} className={`py-3 text-sm ${i !== visibleItems.length - 1 ? "ledger-rule" : ""}`}>
                {editingId === item.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      type: item.type,
                      name: item.name,
                      currentValue: item.currentValue,
                      costBasis: item.costBasis,
                      purchaseDate: item.purchaseDate.slice(0, 10),
                      riskLevel: item.riskLevel,
                      liquidity: item.liquidity,
                    }}
                    onSave={(values) => onUpdate(item.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="flex flex-wrap items-center gap-2 text-ink">
                          {item.name}
                          {byId.get(item.id) ? (
                            byId.get(item.id)!.sipStatus !== "NONE" && <SipStatusBadge status={byId.get(item.id)!.sipStatus} />
                          ) : (
                            item.sipActive && <Badge tone="success">Recurring</Badge>
                          )}
                          {byId.get(item.id)?.freshness === "STALE" && <Badge tone="warning">Value is old</Badge>}
                          {byId.get(item.id)?.freshness === "UNDATED" && <Badge tone="info">Value not dated</Badge>}
                        </p>
                        <p className="text-xs text-ink-faint">
                          {pretty(item.type)} · {pretty(item.riskLevel)} risk · {pretty(item.liquidity)}
                        </p>
                        {byId.get(item.id) && (
                          <p className="text-xs text-ink-faint">
                            {(() => {
                              const p = byId.get(item.id)!;
                              const parts = [p.valuedAt ? `value as of ${formatDay(p.valuedAt)}` : "value saved on the holding"];
                              if (p.returnRatio !== null) parts.push(`return ${formatPercent(Number(p.returnRatio) * 100)}`);
                              if (p.xirr !== null) parts.push(`${formatPercent(Number(p.xirr) * 100)} a year`);
                              return parts.join(" · ");
                            })()}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <p className="money text-ink">{formatINR(item.currentValue)}</p>
                          <p className="text-xs text-ink-faint">invested {formatINR(byId.get(item.id)?.invested ?? item.costBasis)}</p>
                        </div>
                        {confirmDeleteId === item.id ? (
                          <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                            <span className="text-ink-soft">Delete this holding and everything recorded for it (transactions, value history, sale records)?</span>
                            <button type="button" onClick={() => onDelete(item.id)} className="font-medium text-loss hover:underline">
                              Delete
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(null)} className="text-ink-faint hover:underline">
                              Keep
                            </button>
                          </span>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => setExpandedId(expandedId === item.id ? null : item.id)}
                              aria-expanded={expandedId === item.id}
                              aria-label={`${expandedId === item.id ? "Hide" : "Show"} details for ${item.name}`}
                              className="text-xs font-medium text-marigold-600 hover:underline"
                            >
                              {expandedId === item.id ? "Hide details" : "Details"}
                            </button>
                            <button type="button" onClick={() => setEditingId(item.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                              Edit
                            </button>
                            <button type="button" onClick={() => setConfirmDeleteId(item.id)} className="text-xs text-ink-faint hover:text-loss">
                              Remove
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    {expandedId === item.id && <HoldingLedger investment={item} onChanged={load} />}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      )}

      <AddHoldingDialog open={addOpen} onClose={() => setAddOpen(false)} onSaved={done} />
    </div>
  );
}
