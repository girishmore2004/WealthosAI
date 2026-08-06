import { Card } from "@/components/ui/Card";

const moneyModules: { title: string; description: string }[] = [
  { title: "Income & expenses", description: "Track earnings and spending, with category breakdowns and subscription detection." },
  { title: "Investments", description: "Portfolio tracking across asset types, plus a target-allocation rebalancer." },
  { title: "Loans & debt", description: "Amortization schedules, prepayment calculators, snowball/avalanche payoff plans." },
  { title: "Insurance", description: "Policy tracking with a coverage-gap analysis and nominee summary." },
  { title: "Goals", description: "Savings goals with an on-track / at-risk / off-track feasibility check." },
  { title: "Retirement & tax", description: "Corpus and SIP planning, plus old-vs-new Indian tax regime comparison." },
  { title: "Property & business", description: "A property portfolio and a business tracker, kept cleanly separate from personal income." },
  { title: "Household & documents", description: "Multiple household members with role-based visibility, and a secure document vault." },
];

const planningFeatures: { title: string; description: string }[] = [
  { title: "Dashboard", description: "Net worth, cashflow, and a rules-based financial health score at a glance." },
  { title: "Reports", description: "Monthly and yearly summaries, computed server-side, with CSV export." },
  { title: "Alerts", description: "A deterministic, explainable rules engine for renewals, EMIs, overspending, and more." },
  { title: "What-If Simulator", description: "Model SIP increases, loan prepayment, retirement-age shifts, and more - before you commit." },
];

function ModuleGrid({ items }: { items: { title: string; description: string }[] }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((item) => (
        <Card key={item.title} className="h-full">
          <h3 className="font-display text-base text-ink">{item.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-ink-soft">{item.description}</p>
        </Card>
      ))}
    </div>
  );
}

export function ModulesSection() {
  return (
    <section id="modules" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 max-w-2xl">
        <p className="text-xs uppercase tracking-wide text-marigold-600">Money modules</p>
        <h2 className="mt-2 font-display text-3xl text-ink">Every part of your financial life, connected</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          No more spreadsheets scattered across apps. Every module feeds the same
          dashboard, reports, and alerts.
        </p>
      </div>
      <ModuleGrid items={moneyModules} />
      <div className="mt-10 mb-4">
        <p className="text-xs uppercase tracking-wide text-marigold-600">Planning & analytics</p>
        <h3 className="mt-2 font-display text-2xl text-ink">See where you stand, and where you're headed</h3>
      </div>
      <ModuleGrid items={planningFeatures} />
    </section>
  );
}
