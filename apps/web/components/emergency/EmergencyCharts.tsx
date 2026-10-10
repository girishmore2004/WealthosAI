"use client";

import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EmergencyFundOverviewDTO } from "@wealthos/types";
import { formatINR } from "@/lib/format";
import { formatMonth } from "@/lib/dates";

const axis = { fontSize: 11, fill: "#8A93A6" };
const tip = { fontSize: 12, borderRadius: 8, borderColor: "#E9E5D8" };
const compact = (v: number) => (Math.abs(v) >= 100000 ? `${(v / 100000).toFixed(v >= 1000000 ? 0 : 1)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

/** Balance at the end of each of the last 12 months, with the target as a reference line when there is one. */
export function BalanceTrendChart({ overview }: { overview: EmergencyFundOverviewDTO }) {
  const data = overview.trend.map((t) => ({ month: formatMonth(t.month), balance: Number(t.closingBalance) }));
  if (overview.entryCount === 0) return <p className="py-8 text-center text-sm text-ink-faint">Add money to start building this history.</p>;
  const target = overview.target.amount ? Number(overview.target.amount) : null;
  return (
    <div style={{ width: "100%", height: 220 }} role="img" aria-label="Emergency fund balance over the last 12 months">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="#E9E5D8" />
          <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} domain={[0, (max: number) => Math.max(max, target ?? 0)]} />
          <Tooltip formatter={(v: number) => [formatINR(v), "Balance"]} contentStyle={tip} />
          {target !== null && <ReferenceLine y={target} stroke="#B9B29A" strokeDasharray="4 3" label={{ value: "Target", position: "insideTopRight", fontSize: 11, fill: "#8A93A6" }} />}
          <Line type="stepAfter" dataKey="balance" stroke="#2F7D5D" strokeWidth={2} dot={{ r: 2 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Money added vs money used, month by month. */
export function ContributionVsUseChart({ overview }: { overview: EmergencyFundOverviewDTO }) {
  const data = overview.trend.map((t) => ({ month: formatMonth(t.month), added: Number(t.added), used: Number(t.used) }));
  if (!data.some((d) => d.added || d.used)) return <p className="py-8 text-center text-sm text-ink-faint">Nothing added or used in the last 12 months.</p>;
  return (
    <div style={{ width: "100%", height: 220 }} role="img" aria-label="Money added and used each month">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} stroke="#E9E5D8" />
          <XAxis dataKey="month" tick={axis} axisLine={false} tickLine={false} interval="preserveStartEnd" />
          <YAxis tick={axis} axisLine={false} tickLine={false} width={44} tickFormatter={compact} />
          <Tooltip formatter={(v: number, n: string) => [formatINR(v), n === "added" ? "Added" : "Used"]} contentStyle={tip} />
          <Legend formatter={(v) => (v === "added" ? "Added" : "Used")} wrapperStyle={{ fontSize: 12 }} />
          <Bar dataKey="added" fill="#2F7D5D" radius={[3, 3, 0, 0]} />
          <Bar dataKey="used" fill="#D98F2B" radius={[3, 3, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
