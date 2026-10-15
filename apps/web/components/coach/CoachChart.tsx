"use client";

import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CoachChartDTO } from "@wealthos/types";
import { formatINR } from "@/lib/format";
import { CHART, CHART_PALETTE, axisTick, tooltipStyle } from "@/lib/chart-theme";

const compact = (v: number) => (Math.abs(v) >= 100000 ? `${(v / 100000).toFixed(v >= 1000000 ? 0 : 1)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));

function fmt(value: number, unit: CoachChartDTO["unit"]): string {
  if (unit === "INR") return formatINR(value);
  if (unit === "%") return `${value}%`;
  return `${value} months`;
}

/**
 * Draws a chart straight from the report's own data. A null cell means "no data" and is left out of the drawing
 * (never plotted as zero). If nothing numeric is left, a plain message is shown instead of an empty chart.
 */
export function CoachChart({ chart }: { chart: CoachChartDTO }) {
  const keys = chart.series.map((s) => s.key);
  const hasData = chart.data.some((row) => keys.some((k) => typeof row[k] === "number"));
  const labels = Object.fromEntries(chart.series.map((s) => [s.key, s.label]));

  return (
    <figure className="space-y-1.5">
      <figcaption className="text-xs font-medium text-ink">{chart.title}</figcaption>
      {!hasData ? (
        <p className="rounded-md bg-surface-muted p-3 text-xs text-ink-faint">No data recorded for this chart.</p>
      ) : (
        <div style={{ width: "100%", height: 190 }} role="img" aria-label={chart.title}>
          <ResponsiveContainer>
            {chart.kind === "pie" ? (
              <PieChart>
                <Pie data={chart.data} dataKey={keys[0]} nameKey={chart.xKey} outerRadius={70}>
                  {chart.data.map((_, i) => (
                    <Cell key={i} fill={CHART_PALETTE[i % CHART_PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmt(v, chart.unit)} contentStyle={tooltipStyle} />
              </PieChart>
            ) : chart.kind === "line" ? (
              <LineChart data={chart.data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey={chart.xKey} tick={axisTick} axisLine={false} tickLine={false} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} tickFormatter={chart.unit === "INR" ? compact : undefined} />
                <Tooltip formatter={(v: number, n: string) => [fmt(v, chart.unit), labels[n] ?? n]} contentStyle={tooltipStyle} />
                {keys.map((k, i) => (
                  <Line key={k} type="monotone" dataKey={k} stroke={CHART_PALETTE[i % CHART_PALETTE.length]} strokeWidth={2} dot={{ r: 2 }} connectNulls={false} />
                ))}
              </LineChart>
            ) : (
              <BarChart data={chart.data} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey={chart.xKey} tick={axisTick} axisLine={false} tickLine={false} interval={0} />
                <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} tickFormatter={chart.unit === "INR" ? compact : undefined} />
                <Tooltip formatter={(v: number, n: string) => [fmt(v, chart.unit), labels[n] ?? n]} contentStyle={tooltipStyle} />
                {keys.map((k, i) => (
                  <Bar key={k} dataKey={k} fill={CHART_PALETTE[i % CHART_PALETTE.length]} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      {/* The numbers are also available as text for screen readers and for copying. */}
      <table className="sr-only">
        <caption>{chart.title}</caption>
        <tbody>
          {chart.data.map((row, i) => (
            <tr key={i}>
              <th>{String(row[chart.xKey] ?? "")}</th>
              {keys.map((k) => (
                <td key={k}>{typeof row[k] === "number" ? fmt(row[k] as number, chart.unit) : "no data"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {chart.note && <p className="text-[11px] text-ink-faint">{chart.note}</p>}
      <p className="text-[11px] text-ink-faint">Source: {chart.source}</p>
    </figure>
  );
}
