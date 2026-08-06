const points: { title: string; description: string }[] = [
  {
    title: "Passwordless by design",
    description: "There's no password to leak, because none is ever stored. Sessions use a secure, httpOnly cookie.",
  },
  {
    title: "Your data stays scoped to you",
    description: "Every record is read and written against your own account - a household owner sees per-member detail; members see rollups only.",
  },
  {
    title: "PII is redacted before any AI call",
    description: "Emails, phone numbers, PAN, and Aadhaar-shaped text are stripped from free text before it ever reaches a model.",
  },
  {
    title: "Human approval for AI-suggested writes",
    description: "Copilot Ingestion never creates an expense automatically - every suggestion sits in a review queue until you approve it.",
  },
];

export function TrustSection() {
  return (
    <section id="security" className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
      <div className="mb-8 max-w-2xl">
        <p className="text-xs uppercase tracking-wide text-marigold-600">Security & privacy</p>
        <h2 className="mt-2 font-display text-3xl text-ink">Built with your financial data in mind</h2>
      </div>
      <div className="grid gap-6 sm:grid-cols-2">
        {points.map((point) => (
          <div key={point.title} className="border-l-2 border-marigold-500 pl-4">
            <h3 className="font-display text-base text-ink">{point.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-ink-soft">{point.description}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
