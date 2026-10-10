"use client";

import { useEffect, useState } from "react";
import type { ExpenseAnalyticsDTO } from "@wealthos/types";
import { api, ApiError, ExpensePeriodName } from "@/lib/api-client";
import { Modal } from "@/components/ui/Modal";
import { BasisTag } from "@/components/ui/BasisTag";
import { SpendingTrendChart } from "@/components/expenses/SpendingTrendChart";
import { ChangeBadge } from "@/components/expenses/CategoryList";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

const TABS: Array<{ value: ExpensePeriodName; label: string }> = [
  { value: "TODAY", label: "Today" },
  { value: "YESTERDAY", label: "Yesterday" },
  { value: "THIS_WEEK", label: "This week" },
  { value: "THIS_MONTH", label: "This month" },
  { value: "LAST_MONTH", label: "Last month" },
  { value: "THIS_YEAR", label: "This year" },
  { value: "LAST_YEAR", label: "Last year" },
];

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-line p-3">
      <dt className="stat-label">{label}</dt>
      <dd className="money mt-1 text-sm text-ink">{value}</dd>
      {sub && <dd className="mt-0.5 text-[11px] text-ink-faint">{sub}</dd>}
    </div>
  );
}

// Level 4: everything about ONE category over a chosen period. All figures are computed by the
// server (the analytics endpoint with a categoryId); this component only lays them out.
export function CategoryDrillDown({
  categoryId,
  categoryName,
  today,
  initialPeriod = "THIS_MONTH",
  onClose,
}: {
  categoryId: string | null;
  categoryName: string;
  today: string;
  initialPeriod?: ExpensePeriodName;
  onClose: () => void;
}) {
  const [period, setPeriod] = useState<ExpensePeriodName>(initialPeriod);
  const [data, setData] = useState<ExpenseAnalyticsDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (categoryId) setPeriod(TABS.some((t) => t.value === initialPeriod) ? initialPeriod : "THIS_MONTH");
  }, [categoryId, initialPeriod]);

  useEffect(() => {
    if (!categoryId) return;
    let active = true;
    setData(null);
    setError(null);
    api.expenses
      .analytics({ period, today, categoryId, flowType: "EXPENSE" })
      .then((d) => active && setData(d))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : "Could not load this category."));
    return () => {
      active = false;
    };
  }, [categoryId, period, today]);

  const t = data?.totals;

  return (
    <Modal open={categoryId !== null} onClose={onClose} title={categoryName} size="lg">
      <div role="tablist" aria-label="Period" className="mb-4 flex gap-1 overflow-x-auto border-b border-line pb-px">
        {TABS.map((tab) => (
          <button
            key={tab.value}
            role="tab"
            type="button"
            aria-selected={period === tab.value}
            onClick={() => setPeriod(tab.value)}
            className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${period === tab.value ? "border-marigold-500 font-medium text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div role="tabpanel" aria-live="polite">
        {error ? (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        ) : !data || !t ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : (
          <div className="space-y-5">
            <div>
              <div className="flex items-center gap-2">
                <p className="money text-3xl font-semibold text-ink">{formatINR(t.total)}</p>
                <BasisTag basis="ACTUAL" />
              </div>
              <p className="mt-1 text-sm text-ink-soft">
                {formatDay(data.period.from)}
                {data.period.from !== data.period.to ? ` – ${formatDay(data.period.to)}` : ""}
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
                <span>
                  Previous period ({formatDay(data.comparison.from)} – {formatDay(data.comparison.to)}): <span className="money">{formatINR(data.comparison.total)}</span>
                </span>
                <ChangeBadge percent={data.comparison.changePercent} />
              </p>
              {data.yearOverYear && (
                <p className="mt-1 flex flex-wrap items-center gap-x-2 text-sm text-ink-soft">
                  <span>
                    Same period last year: <span className="money">{formatINR(data.yearOverYear.total)}</span>
                  </span>
                  <ChangeBadge percent={data.yearOverYear.changePercent} />
                </p>
              )}
            </div>

            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Transactions" value={String(t.transactionCount)} />
              <Stat label="Average per transaction" value={t.averagePerTransaction ? formatINR(t.averagePerTransaction) : "—"} />
              <Stat label="Average per day" value={formatINR(t.averagePerDay)} />
              <Stat label="Share of all expenses" value={data.overall?.sharePercent != null ? `${data.overall.sharePercent.toFixed(1)}%` : "—"} />
              <Stat label="Highest spending day" value={data.highestDay ? formatINR(data.highestDay.total) : "—"} sub={data.highestDay ? formatDay(data.highestDay.date) : undefined} />
              <Stat label="Lowest spending day" value={data.lowestDay ? formatINR(data.lowestDay.total) : "—"} sub={data.lowestDay ? formatDay(data.lowestDay.date) : undefined} />
              <Stat label="Largest transaction" value={t.largest ? formatINR(t.largest.amount) : "—"} sub={t.largest ? `${t.largest.merchant ?? t.largest.categoryName} · ${formatDay(t.largest.spentAt)}` : undefined} />
              <Stat label="Smallest transaction" value={t.smallest ? formatINR(t.smallest.amount) : "—"} sub={t.smallest ? `${t.smallest.merchant ?? t.smallest.categoryName} · ${formatDay(t.smallest.spentAt)}` : undefined} />
            </dl>

            <SpendingTrendChart analytics={data} defaultGrain={period === "THIS_YEAR" || period === "LAST_YEAR" ? "monthly" : "daily"} />
          </div>
        )}
      </div>
    </Modal>
  );
}
