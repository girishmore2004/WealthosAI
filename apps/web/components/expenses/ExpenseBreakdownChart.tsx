"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CategoryBreakdownDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatINR } from "@/lib/format";

// Cycles through the theme's marigold shades so the bars stay on-palette without
// hardcoding one color per category (categories are user-defined, so the count varies).
const BAR_COLORS = ["#B8721C", "#D98F2B", "#E3A94A", "#4B5568", "#8A93A6"];

export function ExpenseBreakdownChart({ month, refreshKey }: { month?: string; refreshKey?: number }) {
  const [data, setData] = useState<CategoryBreakdownDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    api.expenses
      .breakdown(month)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load the breakdown."));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, refreshKey]);

  if (error) {
    return (
      <Card eyebrow="By category" title="Where it went">
        <p className="text-sm text-loss">{error}</p>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card eyebrow="By category" title="Where it went">
        <p className="text-sm text-ink-faint">Loading…</p>
      </Card>
    );
  }

  if (data.length === 0) {
    return (
      <Card eyebrow="By category" title="Where it went">
        <p className="text-sm text-ink-faint">No expenses to break down yet.</p>
      </Card>
    );
  }

  const chartData = data.map((d) => ({ name: d.name, total: d.total }));
  const rowHeight = 36;

  return (
    <Card eyebrow="By category" title="Where it went">
      <div style={{ width: "100%", height: Math.max(chartData.length * rowHeight, 120) }}>
        <ResponsiveContainer>
          <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 24, top: 4, bottom: 4 }}>
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={120}
              tick={{ fontSize: 12, fill: "#4B5568" }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number) => formatINR(value)}
              contentStyle={{ fontSize: 12, borderRadius: 4, borderColor: "#E4E0D4" }}
            />
            <Bar dataKey="total" radius={[0, 3, 3, 0]}>
              {chartData.map((_, i) => (
                <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
