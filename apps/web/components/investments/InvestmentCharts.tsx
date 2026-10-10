"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { InvestmentAnalyticsDTO, InvestmentDTO } from "@wealthos/types";
import { formatINR, formatPercent } from "@/lib/format";
import { formatMonth } from "@/lib/dates";

const axis = { fontSize: 11, fill: "#8A93A6" };
const tip = { fontSize: 12, borderRadius: 8, borderColor: "#E9E5D8" };
const compact = (v: number) => (Math.abs(v) >= 100000 ? `${Math.round(v / 100000)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
const label = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

function Frame({ height = 220, ariaLabel, children }: { height?: number; ariaLabel: string; children: React.ReactElement }) {
  return (
    <div style={{ width: "100%", height }} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer>{children}</ResponsiveContainer>
    </div>
  );
}

/** Invested vs current value, one pair of bars per holding (values straight from the holdings). */
export function InvestedVsCurrentChart({ items }: { items: InvestmentDTO[] }) {
  if (items.length === 0) return <p className="py-8 text-center text-sm text-ink-faint">Add a holding to see this chart.</p>;
  const data = items.map((i) => ({ name: i.name.length > 14 ? `${i.name.slice(0, 13)}…` : i.name, invested: Number(i.costBasis), current: Number(i.currentValue) }));
  return (
    <Frame ariaLabel="Invested versus current value by holding">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="#E9E5D8" />
        <XAxis dataKey="name" tick={axis} axisLine={false} tickLine={false} interval={0} />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
        <Tooltip formatter={(v: number, n: string) => [formatINR(v), n === "invested" ? "Invested" : "Current value"]} contentStyle={tip} />
        <Legend formatter={(v) => (v === "invested" ? "Invested" : "Current value")} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="invested" fill="#B9B29A" radius={[3, 3, 0, 0]} />
        <Bar dataKey="current" fill="#2F7D5D" radius={[3, 3, 0, 0]} />
      </BarChart>
    </Frame>
  );
}

/** Money added each month (your own contributions, employer's share and money taken back out). */
export function ContributionTrendChart({ analytics }: { analytics: InvestmentAnalyticsDTO }) {
  const data = analytics.contributionTrend.map((r) => ({ month: formatMonth(r.month), contributions: Number(r.contributions), employer: Number(r.employer), withdrawals: Number(r.withdrawals) }));
  if (!data.some((d) => d.contributions || d.employer || d.withdrawals)) {
    return <p className="py-8 text-center text-sm text-ink-faint">No contributions recorded in this period.</p>;
  }
  return (
    <Frame ariaLabel="Monthly contributions">
      <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="#E9E5D8" />
        <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
        <Tooltip formatter={(v: number, n: string) => [formatINR(v), n === "contributions" ? "You added" : n === "employer" ? "Employer added" : "Taken out"]} contentStyle={tip} />
        <Legend formatter={(v) => (v === "contributions" ? "You added" : v === "employer" ? "Employer added" : "Taken out")} wrapperStyle={{ fontSize: 12 }} />
        <Bar dataKey="contributions" stackId="in" fill="#2F7D5D" />
        <Bar dataKey="employer" stackId="in" fill="#8CC5A2" />
        <Bar dataKey="withdrawals" fill="#D98F2B" radius={[3, 3, 0, 0]} />
      </BarChart>
    </Frame>
  );
}

/** Portfolio value over time, from the dated valuations you have recorded (carried forward). */
export function ValueTrendChart({ analytics }: { analytics: InvestmentAnalyticsDTO }) {
  const data = analytics.valueTrend.map((r) => ({ month: formatMonth(r.month), value: r.value === null ? null : Number(r.value) }));
  if (!data.some((d) => d.value !== null)) {
    return <p className="py-8 text-center text-sm text-ink-faint">Record a value for a holding (open it and choose “Update value”) to build this history.</p>;
  }
  return (
    <Frame ariaLabel="Portfolio value over time">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="#E9E5D8" />
        <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} domain={["auto", "auto"]} />
        <Tooltip formatter={(v: number) => [formatINR(v), "Recorded value"]} contentStyle={tip} />
        <Line type="monotone" dataKey="value" stroke="#2F7D5D" strokeWidth={2} dot={{ r: 2 }} connectNulls />
      </LineChart>
    </Frame>
  );
}

/** Gain or loss over time: value minus what is net invested, for holdings that have both a ledger and a value. */
export function GainTrendChart({ analytics }: { analytics: InvestmentAnalyticsDTO }) {
  const data = analytics.gainTrend.map((r) => ({ month: formatMonth(r.month), gain: r.gain === null ? null : Number(r.gain) }));
  if (!data.some((d) => d.gain !== null)) {
    return <p className="py-8 text-center text-sm text-ink-faint">Needs a holding with both recorded contributions and a recorded value.</p>;
  }
  return (
    <Frame ariaLabel="Gain or loss over time">
      <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
        <CartesianGrid vertical={false} stroke="#E9E5D8" />
        <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" />
        <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
        <Tooltip formatter={(v: number) => [`${v < 0 ? "−" : "+"}${formatINR(Math.abs(v))}`, v < 0 ? "Loss" : "Gain"]} contentStyle={tip} />
        <Line type="monotone" dataKey="gain" stroke="#D98F2B" strokeWidth={2} dot={{ r: 2 }} connectNulls />
      </LineChart>
    </Frame>
  );
}

function AllocationList({ title, rows }: { title: string; rows: Array<{ key: string; value: string; percent: number }> }) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-ink-faint">{title}</h3>
      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">Nothing yet.</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.key}>
              <div className="flex items-baseline justify-between text-sm">
                <span className="text-ink">{label(r.key)}</span>
                <span className="money text-ink-soft">
                  {formatINR(r.value)} · {formatPercent(r.percent)}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-muted" aria-hidden="true">
                <div className="h-1.5 rounded-full bg-marigold-500" style={{ width: `${Math.min(100, Math.max(0, r.percent))}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** How the CURRENT recorded value is split by type, risk level and liquidity (percentages computed on the server). */
export function AllocationPanel({ analytics }: { analytics: InvestmentAnalyticsDTO }) {
  const a = analytics.allocation;
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <AllocationList title="By type" rows={a.byType} />
      <AllocationList title="By risk" rows={a.byRisk} />
      <AllocationList title="By liquidity" rows={a.byLiquidity} />
    </div>
  );
}
