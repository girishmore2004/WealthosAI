"use client";

import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CategoryBreakdownDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatINR } from "@/lib/format";
import { CHART, CHART_PALETTE, tooltipStyle } from "@/lib/chart-theme";

// Cycles through the theme-aware chart palette so the bars stay on-palette in both themes without
// hardcoding one color per category (categories are user-defined, so the count varies).
const BAR_COLORS = CHART_PALETTE;

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
              tick={{ fontSize: 12, fill: CHART.axisStrong }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              formatter={(value: number) => formatINR(value)}
              contentStyle={tooltipStyle}
            />
            <Bar dataKey="total" radius={[0, 4, 4, 0]}>
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
