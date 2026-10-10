"use client";

import { useState } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ExpenseAnalyticsDTO } from "@wealthos/types";
import { formatINR } from "@/lib/format";
import { formatDay, formatMonth } from "@/lib/dates";

type Grain = "daily" | "weekly" | "monthly";

const GRAINS: Array<{ value: Grain; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

// Plots the series the API already aggregated (daily / weekly / monthly) — it never sums or
// buckets anything itself. Tooltips show the exact rupee value; the table-style summary below the
// chart gives the same numbers as text for anyone who can't use the chart.
export function SpendingTrendChart({ analytics, defaultGrain = "daily" }: { analytics: ExpenseAnalyticsDTO; defaultGrain?: Grain }) {
  const [grain, setGrain] = useState<Grain>(defaultGrain);

  const data =
    grain === "daily"
      ? analytics.daily.map((d) => ({ key: d.date, label: d.date.slice(8), full: formatDay(d.date), total: Number(d.total) }))
      : grain === "weekly"
        ? analytics.weekly.map((w) => ({ key: w.weekStart, label: w.weekStart.slice(5), full: `Week of ${formatDay(w.weekStart)}`, total: Number(w.total) }))
        : analytics.monthly.map((m) => ({ key: m.month, label: formatMonth(m.month), full: formatMonth(m.month), total: Number(m.total) }));

  const hasSpending = data.some((d) => d.total > 0);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div role="group" aria-label="Chart granularity" className="inline-flex overflow-hidden rounded-md border border-line text-xs">
          {GRAINS.map((g) => (
            <button
              key={g.value}
              type="button"
              aria-pressed={grain === g.value}
              onClick={() => setGrain(g.value)}
              className={`px-3 py-1.5 ${grain === g.value ? "bg-marigold-50 font-medium text-ink" : "text-ink-soft hover:bg-surface-muted"}`}
            >
              {g.label}
            </button>
          ))}
        </div>
        <span className="text-xs text-ink-faint">Actual spending</span>
      </div>

      {!hasSpending ? (
        <p className="py-10 text-center text-sm text-ink-faint">No spending in this period.</p>
      ) : (
        <div style={{ width: "100%", height: 220 }} role="img" aria-label={`${grain} spending chart`}>
          <ResponsiveContainer>
            <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke="#E9E5D8" />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#8A93A6" }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 11, fill: "#8A93A6" }} axisLine={false} tickLine={false} width={48} tickFormatter={(v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(v))} />
              <Tooltip
                formatter={(value: number) => [formatINR(value), "Spent"]}
                labelFormatter={(_label, payload) => (payload && payload[0] ? (payload[0].payload as { full: string }).full : "")}
                contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#E9E5D8" }}
              />
              <Bar dataKey="total" fill="#D98F2B" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
