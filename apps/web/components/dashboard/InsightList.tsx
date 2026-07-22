import type { InsightDTO } from "@wealthos/types";

const SEVERITY_STYLES: Record<InsightDTO["severity"], string> = {
  INFO: "border-line",
  WARNING: "border-marigold-500",
  CRITICAL: "border-loss",
};

export function InsightList({ insights }: { insights: InsightDTO[] }) {
  return (
    <div className="rounded-sm border border-line bg-surface p-5">
      <p className="mb-3 text-xs uppercase tracking-wide text-ink-faint">Insights</p>
      <ul className="space-y-3">
        {insights.map((insight) => (
          <li key={insight.id} className={`border-l-2 pl-3 ${SEVERITY_STYLES[insight.severity]}`}>
            <p className="text-sm font-medium text-ink">{insight.title}</p>
            <p className="mt-0.5 text-xs text-ink-soft">{insight.detail}</p>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[11px] text-ink-faint">
        These are projections based on the data logged so far, not financial advice or a guarantee.
      </p>
    </div>
  );
}
