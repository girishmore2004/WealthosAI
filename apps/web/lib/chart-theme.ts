// Theme-aware styling for every Recharts chart. Colours resolve from the CSS variables defined in
// app/globals.css, so a chart repaints the moment the theme changes — no re-render, no hardcoded hex.
const c = (name: string) => `rgb(var(--${name}))`;

export const CHART = {
  grid: c("line"),
  axis: c("ink-faint"),
  axisStrong: c("ink-soft"),
  ink: c("ink"),
  surface: c("surface"),
  primary: c("accent"),
  secondary: c("accent-2"),
  gain: c("gain-chart"),
  loss: c("loss-chart"),
  warn: c("warn-chart"),
  muted: c("series-muted"),
} as const;

/** Categorical palette for multi-bar charts: primary, secondary, positive, warning, neutral. */
export const CHART_PALETTE = [CHART.primary, CHART.secondary, CHART.gain, CHART.warn, CHART.muted] as const;

export const axisTick = { fontSize: 11, fill: CHART.axis };

export const tooltipStyle = {
  fontSize: 12,
  borderRadius: 8,
  border: `1px solid ${CHART.grid}`,
  backgroundColor: CHART.surface,
  color: CHART.ink,
  boxShadow: "var(--shadow-popover)",
};

export const tooltipLabelStyle = { color: CHART.axisStrong };
export const tooltipItemStyle = { color: CHART.ink };
export const legendStyle = { fontSize: 12, color: CHART.axisStrong };
