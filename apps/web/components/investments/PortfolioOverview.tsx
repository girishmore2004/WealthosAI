import type { InvestmentAnalyticsDTO, InvestmentSummaryDTO, PortfolioProjectionDTO } from "@wealthos/types";
import { BasisTag, FactBasis } from "@/components/ui/BasisTag";
import { formatINR, formatPercent } from "@/lib/format";

function Stat({ label, value, sub, basis, tone }: { label: string; value: string | null; sub?: string; basis: FactBasis; tone?: "gain" | "loss" }) {
  const color = tone === "gain" ? "text-gain" : tone === "loss" ? "text-loss" : "text-ink";
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="stat-label">{label}</p>
        <BasisTag basis={basis} />
      </div>
      <p className={`money mt-2 text-xl font-semibold ${color}`}>{value ?? "—"}</p>
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

// Level 1 of the page. Every figure is labelled with what KIND of fact it is: what the holdings are
// worth now (ACTUAL), what the schedules plan to put in (FORECAST — a plan, not a transaction) and what
// the portfolio could become (PROJECTED — an assumption). They sit in separate groups so a projected
// number is never read as a recorded one.
export function PortfolioOverview({
  summary,
  analytics,
  projection,
  projectionYears,
}: {
  summary: InvestmentSummaryDTO | null;
  analytics: InvestmentAnalyticsDTO | null;
  projection: PortfolioProjectionDTO | null;
  projectionYears: number;
}) {
  const gain = summary ? Number(summary.totalGainLoss) : 0;
  const tone = summary ? (gain > 0 ? "gain" : gain < 0 ? "loss" : undefined) : undefined;
  const scenario = projection?.scenarios.find((s) => s.years === projectionYears) ?? null;
  const o = analytics?.overview;

  return (
    <div className="space-y-4">
      <section aria-labelledby="portfolio-heading">
        <h2 id="portfolio-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Your portfolio today
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Total invested" value={summary ? formatINR(summary.totalCostBasis) : null} sub="cost basis of your holdings" basis="ACTUAL" />
          <Stat label="Current value" value={summary ? formatINR(summary.totalCurrentValue) : null} basis="ACTUAL" />
          <Stat
            label="Gain / loss"
            value={summary ? `${gain > 0 ? "+" : gain < 0 ? "−" : ""}${formatINR(Math.abs(gain))}` : null}
            sub={summary ? (gain > 0 ? "above what you put in" : gain < 0 ? "below what you put in" : undefined) : undefined}
            basis="ACTUAL"
            tone={tone}
          />
          <Stat label="Return" value={summary ? `${summary.totalGainLossPercent > 0 ? "+" : ""}${formatPercent(summary.totalGainLossPercent)}` : null} basis="ACTUAL" tone={tone} />
        </div>
      </section>

      <section aria-labelledby="contrib-heading">
        <h2 id="contrib-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Your contributions
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Monthly contribution"
            value={o ? formatINR(o.plannedMonthlyContribution) : null}
            sub={o ? `planned, from ${o.activeSchedules} active schedule${o.activeSchedules === 1 ? "" : "s"}` : undefined}
            basis="FORECAST"
          />
          <Stat label="Annual contribution" value={o ? formatINR(o.plannedAnnualContribution) : null} sub="planned" basis="FORECAST" />
          <Stat label="Added this month" value={o ? formatINR(o.actualContributionsThisMonth) : null} sub="recorded contributions" basis="ACTUAL" />
          <Stat label="Added this year" value={o ? formatINR(o.actualContributionsThisYear) : null} sub="recorded contributions" basis="ACTUAL" />
        </div>
      </section>

      <section aria-labelledby="proj-heading">
        <h2 id="proj-heading" className="mb-2 text-sm font-medium text-ink-soft">
          What it could become <span className="font-normal text-ink-faint">(a projection, not a promise)</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label={`Projected value in ${projectionYears} years`}
            value={scenario ? formatINR(scenario.projectedValue) : null}
            sub={projection && projection.includedCount > 0 ? `at an assumed ${projection.defaultAnnualReturnPercent ?? "your own"}% a year` : "choose a return assumption below"}
            basis="PROJECTED"
          />
          <Stat label="Projected growth" value={scenario ? formatINR(scenario.projectedGain) : null} sub="on top of what is put in" basis="PROJECTED" />
        </div>
      </section>
    </div>
  );
}
