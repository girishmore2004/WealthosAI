import type { ExpenseAnalyticsDTO, ExpenseSummaryDTO, MoneyFlowDTO, ReceivableSummaryDTO } from "@wealthos/types";
import { BasisTag } from "@/components/ui/BasisTag";
import { formatINR } from "@/lib/format";

function Stat({ label, value, sub, note }: { label: string; value: string | null; sub?: string; note?: string }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="stat-label">{label}</p>
        <BasisTag basis="ACTUAL" />
      </div>
      <p className="money mt-2 text-xl font-semibold text-ink">{value === null ? "—" : formatINR(value)}</p>
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
      {note && <p className="mt-1 text-[11px] text-ink-faint">{note}</p>}
    </div>
  );
}

// Level 1 of the page: what was SPENT, then — clearly separated — the other places money went.
// Investments, emergency-fund money and money lent are never merged into "expenses"; they sit in
// their own labelled group, and every number comes straight from the API (no maths done here).
export function ExpenseSummaryCards({
  summary,
  analytics,
  moneyFlow,
  receivables,
}: {
  summary: ExpenseSummaryDTO | null;
  analytics: ExpenseAnalyticsDTO | null;
  moneyFlow: MoneyFlowDTO | null;
  receivables: ReceivableSummaryDTO | null;
}) {
  return (
    <div className="space-y-4">
      <section aria-labelledby="spending-heading">
        <h2 id="spending-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Spending
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Today" value={summary?.today ?? null} />
          <Stat label="This month" value={summary?.month ?? null} />
          <Stat label="This year" value={summary?.year ?? null} />
          <Stat
            label="Average per day"
            value={analytics?.totals.averagePerDay ?? null}
            sub={analytics ? `over ${analytics.period.elapsedDays} day${analytics.period.elapsedDays === 1 ? "" : "s"} of the selected period` : undefined}
          />
        </div>
      </section>

      <section aria-labelledby="other-heading">
        <h2 id="other-heading" className="mb-2 text-sm font-medium text-ink-soft">
          Where else your money went <span className="font-normal text-ink-faint">(not counted as expenses)</span>
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Refundable outstanding" value={receivables?.totalOutstanding ?? null} sub="money given, expected back" />
          <Stat label="Investments" value={moneyFlow?.outflows.investments ?? null} sub="this month" />
          <Stat label="Emergency fund" value={moneyFlow?.outflows.emergencyFund ?? null} sub="added this month" />
          <Stat
            label="Total cash outflow"
            value={moneyFlow?.totalGenuineOutflow ?? null}
            sub="this month"
            note="Expenses + investments + emergency fund + money given + other outflow. Internal transfers excluded."
          />
        </div>
      </section>
    </div>
  );
}
