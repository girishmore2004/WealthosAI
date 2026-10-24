import type { InvestmentPortfolioDTO, PortfolioProjectionDTO } from "@wealthos/types";
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

const toneOf = (n: number): "gain" | "loss" | undefined => (n > 0 ? "gain" : n < 0 ? "loss" : undefined);
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${formatINR(Math.abs(n))}`;
const ratioPct = (r: string | null) => (r === null ? null : `${Number(r) > 0 ? "+" : ""}${formatPercent(Number(r) * 100)}`);

const XIRR_WHY: Record<string, string> = {
  NO_FLOWS: "needs dated contributions",
  NEEDS_BOTH_SIGNS: "needs money in and a current value",
  SHORT_HISTORY: "history is under 30 days",
  NOT_CONVERGED: "could not be calculated",
};

// Level 1 of the page. Every figure is labelled with what KIND of fact it is: what the holdings are
// worth now (ACTUAL), what the schedules plan to put in (FORECAST — a plan, not a transaction) and what
// the portfolio could become (PROJECTED — an assumption). Everything ACTUAL comes from one canonical
// server summary, the same one the Home dashboard reads.
export function PortfolioOverview({
  portfolio,
  projection,
  projectionYears,
}: {
  portfolio: InvestmentPortfolioDTO | null;
  projection: PortfolioProjectionDTO | null;
  projectionYears: number;
}) {
  const t = portfolio?.totals;
  const c = portfolio?.contributions;
  const n = portfolio?.counts;
  const unrealized = t ? Number(t.unrealizedGain) : 0;
  const realized = t ? Number(t.realizedGain) : 0;
  const scenario = projection?.scenarios.find((s) => s.years === projectionYears) ?? null;

  return (
    <div className="space-y-4">
      {n && (n.staleValuations > 0 || n.legacyCostBasis > 0) && (
        <p role="note" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-xs text-ink-soft">
          {n.staleValuations > 0 && `${n.staleValuations} holding value${n.staleValuations === 1 ? " is" : "s are"} older than 120 days or undated — use “Update value” to refresh. `}
          {n.legacyCostBasis > 0 && `${n.legacyCostBasis} holding${n.legacyCostBasis === 1 ? " has" : "s have"} no transactions yet, so the amount invested is the figure you saved on it.`}
        </p>
      )}

      <section aria-labelledby="portfolio-heading">
        <h2 id="portfolio-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Your portfolio today
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <Stat label="Total invested" value={t ? formatINR(t.totalInvested) : null} sub="net money still invested (after sales)" basis="ACTUAL" />
          <Stat label="Current value" value={t ? formatINR(t.currentValue) : null} sub="latest recorded values" basis="ACTUAL" />
          <Stat
            label="Gain / loss"
            value={t ? signed(unrealized) : null}
            sub={t ? `unrealised · realised from sales ${signed(realized)}` : undefined}
            basis="ACTUAL"
            tone={t ? toneOf(unrealized) : undefined}
          />
          <Stat
            label="Portfolio return"
            value={t ? (ratioPct(t.returnRatio) ?? "—") : null}
            sub={t ? (t.xirr !== null ? `${ratioPct(t.xirr)} a year (XIRR)` : `XIRR: ${XIRR_WHY[t.xirrReason] ?? "not available"}`) : undefined}
            basis="ACTUAL"
            tone={t ? toneOf(Number(t.totalReturn)) : undefined}
          />
          <Stat label="Active investments" value={n ? String(n.holdings) : null} sub={n ? `${n.activeSips} active SIP${n.activeSips === 1 ? "" : "s"} · ${n.pausedSips} paused · ${n.oneTime} one-time` : undefined} basis="ACTUAL" />
          <Stat label="Total put in" value={t ? formatINR(t.grossContributed) : null} sub={t ? `taken out ${formatINR(t.withdrawn)}` : undefined} basis="ACTUAL" />
        </div>
      </section>

      <section aria-labelledby="contrib-heading">
        <h2 id="contrib-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Your contributions
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat
            label="Monthly investment"
            value={c ? formatINR(c.plannedMonthly) : null}
            sub={n ? `planned, from ${n.activeSips} active schedule${n.activeSips === 1 ? "" : "s"}` : undefined}
            basis="FORECAST"
          />
          <Stat label="Yearly investment" value={c ? formatINR(c.plannedAnnual) : null} sub="planned for a full year" basis="FORECAST" />
          <Stat label="Added this month" value={c ? formatINR(c.actualThisMonth) : null} sub="recorded contributions" basis="ACTUAL" />
          <Stat
            label={c ? `Added in FY ${c.financialYear}` : "Added this financial year"}
            value={c ? formatINR(c.actualThisFinancialYear) : null}
            sub={c ? `calendar year so far: ${formatINR(c.actualThisCalendarYear)}` : undefined}
            basis="ACTUAL"
          />
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
