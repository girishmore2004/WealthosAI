const aiFeatures: { title: string; description: string }[] = [
  {
    title: "AI Search",
    description:
      "Ask questions across your own documents, reports, and financial history. Answers are cited and grounded — with no confident-sounding guesses when the evidence is weak.",
  },
  {
    title: "Agentic Coach",
    description:
      "Plans, verifies, and explains answers to financial questions. Every number in a Coach answer is checked against a real calculation before it's shown to you.",
  },
  {
    title: "ML Insights",
    description:
      "Real statistical models — regression, anomaly detection, risk scoring — run over your own data. Not a black-box score, and no language model involved.",
  },
  {
    title: "Scenario Studio",
    description:
      "Ask a natural-language \"what if\" question and get ranked, explained projections — powered by the same deterministic Simulator engine, re-run with new parameters.",
  },
  {
    title: "Copilot Ingestion",
    description:
      "Paste a bank or card statement and get a reviewable queue of categorized expenses. Nothing is saved to your account until you approve it.",
  },
];

export function AISection() {
  return (
    <section id="ai" className="bg-ink py-16 text-paper">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mb-8 max-w-2xl">
          <p className="text-xs uppercase tracking-wide text-marigold-400">AI, built on a deterministic core</p>
          <h2 className="mt-2 font-display text-3xl text-paper">
            AI that explains your numbers — never invents them
          </h2>
          <p className="mt-3 text-sm leading-relaxed text-paper/70">
            Every calculation in WealthOS AI — net worth, amortization, tax, retirement
            corpus, simulator projections — is computed by plain, auditable logic with
            no model call involved. The AI layer reads and explains that output; it
            never replaces it. Where a generated answer would introduce a number that
            can&apos;t be traced back to something already computed, it&apos;s discarded in
            favor of the raw facts.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {aiFeatures.map((feature) => (
            <div key={feature.title} className="rounded-sm border border-paper/15 bg-paper/5 p-5">
              <h3 className="font-display text-base text-paper">{feature.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-paper/70">{feature.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
