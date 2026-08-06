import type { InsightDTO } from "@wealthos/types";
import { Badge } from "@/components/ui/Badge";

const SEVERITY_STYLES: Record<InsightDTO["severity"], string> = {
  INFO: "border-line",
  WARNING: "border-marigold-500",
  CRITICAL: "border-loss",
};

const SEVERITY_BADGE: Record<InsightDTO["severity"], { tone: "info" | "warning" | "critical"; label: string }> = {
  INFO: { tone: "info", label: "Info" },
  WARNING: { tone: "warning", label: "Watch" },
  CRITICAL: { tone: "critical", label: "Critical" },
};

export function InsightList({ insights }: { insights: InsightDTO[] }) {
  return (
    <div className="panel p-5 sm:p-6">
      <p className="stat-label mb-3">Insights</p>
      <ul className="space-y-3">
        {insights.map((insight) => (
          <li
            key={insight.id}
            className={`rounded-md border-l-2 bg-surface-muted/60 py-2.5 pl-3 pr-3 ${SEVERITY_STYLES[insight.severity]}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-medium text-ink">{insight.title}</p>
              <Badge tone={SEVERITY_BADGE[insight.severity].tone}>{SEVERITY_BADGE[insight.severity].label}</Badge>
            </div>
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
