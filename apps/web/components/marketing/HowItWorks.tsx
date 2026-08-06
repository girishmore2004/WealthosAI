const steps: { number: string; title: string; description: string }[] = [
  {
    number: "01",
    title: "Sign in with your email",
    description:
      "No passwords to create or remember. Enter your email, we send a 6-digit one-time code, and you're in.",
  },
  {
    number: "02",
    title: "Add what you already have",
    description:
      "Income, expenses, investments, loans, insurance, property, business, and goals — add as much or as little as you want, whenever you want.",
  },
  {
    number: "03",
    title: "See your full picture",
    description:
      "A live net worth and health score on your dashboard, deterministic alerts, and — whenever you want a deeper answer — AI Search, Coach, and Scenario Studio.",
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="border-y border-line bg-surface py-16">
      <div className="mx-auto max-w-6xl px-4 sm:px-6">
        <div className="mb-10 max-w-2xl">
          <p className="text-xs uppercase tracking-wide text-marigold-600">How it works</p>
          <h2 className="mt-2 font-display text-3xl text-ink">Up and running in a few minutes</h2>
        </div>
        <div className="grid gap-8 sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.number}>
              <p className="font-display text-3xl text-marigold-500">{step.number}</p>
              <h3 className="mt-2 font-display text-lg text-ink">{step.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{step.description}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
