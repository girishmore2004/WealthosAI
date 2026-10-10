import Link from "next/link";
import type { DashboardOverviewDTO } from "@wealthos/types";
import { BasisTag } from "@/components/ui/BasisTag";
import { ProgressBar } from "@/components/ui/ProgressBar";
import { formatINR, formatPercent } from "@/lib/format";
import { formatDay, formatMonth } from "@/lib/dates";

const rate = (v: number | null) => (v === null ? "—" : formatPercent(v));

function FlowTile({ label, value, share, note }: { label: string; value: string; share?: number | null; note?: string }) {
  return (
    <div className="panel p-4">
      <p className="stat-label">{label}</p>
      <p className="money mt-2 text-xl font-semibold text-ink">{formatINR(value)}</p>
      {share !== undefined && <p className="mt-1 text-xs text-ink-faint">{share === null ? "No income recorded" : `${formatPercent(share)} of income`}</p>}
      {note && <p className="mt-1 text-[11px] text-ink-faint">{note}</p>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <dt className="text-ink-soft">{label}</dt>
      <dd className="money text-ink">{value}</dd>
    </div>
  );
}

// The dashboard's "where did my money go" area. Presentation only: every figure arrives from the
// API already calculated (the same facts the reports and the AI Coach use), and expenses,
// investments, emergency money, money lent and transfers are always shown as separate things.
export function MoneyOverview({ overview }: { overview: DashboardOverviewDTO }) {
  const { moneyFlow: flow, expenses, investments, emergencyFund, receivables, wealth } = overview;
  const net = Number(flow.netCashFlow);

  return (
    <div className="space-y-6">
      <section aria-labelledby="money-flow-heading">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="money-flow-heading" className="font-display text-lg text-ink">
            Where your money went · {formatMonth(overview.month)}
          </h2>
          <BasisTag basis="ACTUAL" />
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <FlowTile label="Income" value={flow.income} />
          <FlowTile label="Expenses" value={flow.outflows.expenses} share={flow.percentOfIncome.expenses} />
          <FlowTile label="Investments" value={flow.outflows.investments} share={flow.percentOfIncome.investments} note="Not an expense" />
          <FlowTile label="Emergency fund" value={flow.outflows.emergencyFund} share={flow.percentOfIncome.emergencyFund} note="A reserve, not an expense" />
          <FlowTile label="Money lent" value={flow.outflows.receivablesGiven} share={flow.percentOfIncome.receivablesGiven} note="An asset until repaid" />
          <FlowTile label="Other outflow" value={flow.outflows.otherOutflow} share={flow.percentOfIncome.otherOutflow} />
        </div>
        <p className="mt-3 text-xs text-ink-faint">
          {formatINR(flow.internalTransfers)} moved between your own accounts — not income, not an expense, in no total.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-3">
          <div className="panel p-4">
            <p className="stat-label">Net cash flow</p>
            <p className={`money mt-2 text-xl font-semibold ${net < 0 ? "text-loss" : "text-gain"}`}>{formatINR(flow.netCashFlow)}</p>
          </div>
          <div className="panel p-4">
            <p className="stat-label">Savings rate</p>
            <p className="money mt-2 text-xl font-semibold text-ink">{rate(overview.savingsRate)}</p>
            <p className="mt-1 text-[11px] text-ink-faint">Recorded income vs recorded expenses</p>
          </div>
          <div className="panel p-4">
            <p className="stat-label">Investment rate</p>
            <p className="money mt-2 text-xl font-semibold text-ink">{rate(overview.investmentRate)}</p>
          </div>
        </div>
        {overview.narrative.length > 0 && (
          <ul className="mt-4 space-y-1.5 text-sm text-ink-soft" aria-label="Summary of the month">
            {overview.narrative.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="spending-analytics-heading" className="panel p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="spending-analytics-heading" className="font-display text-lg text-ink">
            Spending
          </h2>
          <Link href="/money/expenses" className="text-sm font-medium text-marigold-600 hover:underline">
            View expense details
          </Link>
        </div>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="stat-label">Today</p>
            <p className="money text-lg text-ink">{formatINR(expenses.today)}</p>
          </div>
          <div>
            <p className="stat-label">This month</p>
            <p className="money text-lg text-ink">{formatINR(expenses.month)}</p>
          </div>
          <div>
            <p className="stat-label">This year</p>
            <p className="money text-lg text-ink">{formatINR(expenses.year)}</p>
          </div>
        </div>
        <dl className="mt-4 divide-y divide-line">
          <Row label="Average per day" value={formatINR(expenses.averagePerDay)} />
          <Row label="Essential" value={formatINR(expenses.essential)} />
          <Row label="Discretionary" value={formatINR(expenses.discretionary)} />
          {expenses.topCategory && (
            <Row
              label="Top category"
              value={`${expenses.topCategory.name} · ${formatINR(expenses.topCategory.total)}${expenses.topCategory.sharePercent !== null ? ` (${formatPercent(expenses.topCategory.sharePercent)})` : ""}`}
            />
          )}
          {expenses.largest && <Row label="Largest expense" value={`${formatINR(expenses.largest.amount)} · ${expenses.largest.categoryName}`} />}
          {expenses.highestDay && <Row label="Highest spending day" value={`${formatDay(expenses.highestDay.date)} · ${formatINR(expenses.highestDay.total)}`} />}
        </dl>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="emergency-heading" className="panel p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="emergency-heading" className="font-display text-lg text-ink">
              Emergency fund
            </h2>
            <Link href="/money/emergency-fund" className="text-sm font-medium text-marigold-600 hover:underline">
              View emergency fund details
            </Link>
          </div>
          <p className="money text-2xl font-semibold text-ink">{formatINR(emergencyFund.balance)}</p>
          <div className="mt-3">
            <ProgressBar percent={emergencyFund.progressPercent} label="Emergency fund progress" />
            <p className="mt-1.5 text-xs text-ink-faint">
              {emergencyFund.targetAmount === null
                ? "No target set yet"
                : `${emergencyFund.progressPercent === null ? "—" : formatPercent(emergencyFund.progressPercent)} of the ${formatINR(emergencyFund.targetAmount)} target`}
            </p>
          </div>
          <dl className="mt-3 divide-y divide-line">
            <Row label="Coverage" value={emergencyFund.coverageMonths === null ? "Needs spending history" : `${Number(emergencyFund.coverageMonths).toFixed(2)} months`} />
            <Row label="Added this month" value={formatINR(emergencyFund.contributedThisMonth)} />
          </dl>
        </section>

        <section aria-labelledby="receivables-heading" className="panel p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h2 id="receivables-heading" className="font-display text-lg text-ink">
              Money owed to you
            </h2>
            <Link href="/money/receivables" className="text-sm font-medium text-marigold-600 hover:underline">
              View receivables
            </Link>
          </div>
          <p className="money text-2xl font-semibold text-ink">{formatINR(receivables.outstanding)}</p>
          <p className="mt-1 text-xs text-ink-faint">
            {receivables.activeCount} active · counted as an asset, never an expense
          </p>
          <dl className="mt-3 divide-y divide-line">
            <Row label={`Due within ${receivables.dueSoon.withinDays} days`} value={`${formatINR(receivables.dueSoon.amount)} (${receivables.dueSoon.count})`} />
            <Row label="Overdue" value={`${formatINR(receivables.overdue.amount)} (${receivables.overdue.count})`} />
          </dl>
        </section>
      </div>

      <details className="panel p-5">
        <summary className="cursor-pointer font-display text-lg text-ink">Investments</summary>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="money text-2xl font-semibold text-ink">{formatINR(investments.totalValue)}</p>
          <Link href="/money/investments" className="text-sm font-medium text-marigold-600 hover:underline">
            View investment details
          </Link>
        </div>
        <dl className="mt-3 divide-y divide-line">
          <Row label="Invested this month" value={formatINR(investments.contributedThisMonth)} />
          <Row label="Invested this year" value={formatINR(investments.contributedThisYear)} />
          <Row label="Planned per month (schedules)" value={formatINR(investments.plannedMonthlyContribution)} />
          <Row label="Holdings · active schedules" value={`${investments.holdings} · ${investments.activeSchedules}`} />
        </dl>
      </details>

      <section aria-labelledby="wealth-heading" className="panel p-5">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 id="wealth-heading" className="font-display text-lg text-ink">
            Wealth summary
          </h2>
          <BasisTag basis="ACTUAL" />
        </div>
        <p className="stat-label">Net worth</p>
        <p className="money text-2xl font-semibold text-ink">{formatINR(wealth.netWorth)}</p>
        <dl className="mt-3 grid gap-x-8 sm:grid-cols-2">
          <Row label="Available cash" value={formatINR(wealth.availableCash)} />
          <Row label="Emergency cash" value={formatINR(wealth.emergencyCash)} />
          <Row label="Investments" value={formatINR(wealth.investments)} />
          <Row label="Receivables" value={formatINR(wealth.receivables)} />
          <Row label="Property" value={formatINR(wealth.property)} />
          <Row label="Liabilities" value={formatINR(wealth.liabilities)} />
        </dl>
      </section>
    </div>
  );
}
