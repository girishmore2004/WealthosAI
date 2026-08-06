import type { FinancialHealthScoreDTO } from "@wealthos/types";

const BAND_COPY: Record<FinancialHealthScoreDTO["band"], { label: string; color: string; ring: string }> = {
  AT_RISK: { label: "At risk", color: "text-loss", ring: "#B3462C" },
  NEEDS_ATTENTION: { label: "Needs attention", color: "text-marigold-600", ring: "#D98F2B" },
  STABLE: { label: "Stable", color: "text-ink", ring: "#151E2E" },
  STRONG: { label: "Strong", color: "text-gain", ring: "#2F7D5D" },
};

export function HealthScoreCard({ score }: { score: FinancialHealthScoreDTO }) {
  const band = BAND_COPY[score.band];
  const circumference = 2 * Math.PI * 42;
  const offset = circumference * (1 - score.score / 100);

  return (
    <div className="panel p-5 sm:p-6">
      <p className="stat-label mb-3">Today&apos;s financial health</p>
      <div className="flex items-center gap-5">
        <svg width="96" height="96" viewBox="0 0 96 96" className="shrink-0">
          <circle cx="48" cy="48" r="42" fill="none" stroke="#E9E5D8" strokeWidth="8" />
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke={band.ring}
            strokeWidth="8"
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            strokeLinecap="round"
            transform="rotate(-90 48 48)"
            style={{ transition: "stroke-dashoffset 400ms ease" }}
          />
          <text x="48" y="53" textAnchor="middle" className="money" fontSize="22" fill="#151E2E">
            {score.score}
          </text>
        </svg>
        <div>
          <p className={`font-display text-lg ${band.color}`}>{band.label}</p>
          <dl className="mt-2.5 space-y-1.5 text-xs text-ink-soft">
            <div className="flex justify-between gap-4">
              <dt>Savings rate</dt>
              <dd className="money">{score.breakdown.savingsRate}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Debt-to-income</dt>
              <dd className="money">{score.breakdown.debtToIncome}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt>Emergency fund</dt>
              <dd className="money">{score.breakdown.emergencyFundMonths}</dd>
            </div>
          </dl>
        </div>
      </div>
    </div>
  );
}
