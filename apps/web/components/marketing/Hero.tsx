import Link from "next/link";

export function Hero() {
  return (
    <section className="mx-auto max-w-6xl px-4 pb-16 pt-16 sm:px-6 sm:pt-24">
      <div className="mx-auto max-w-3xl text-center">
        <p className="mb-4 inline-block rounded-sm border border-line bg-surface px-3 py-1 text-xs uppercase tracking-wide text-ink-faint">
          India's personal wealth operating system
        </p>
        <h1 className="font-display text-4xl leading-tight text-ink sm:text-5xl">
          Understand, grow, and protect your money - all in one place.
        </h1>
        <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-ink-soft sm:text-lg">
          Daily spending, investments, loans, insurance, tax, retirement, property,
          business, and family finance - tracked in one connected platform, with an AI
          layer that explains your own numbers instead of guessing at them.
        </p>
        <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <Link
            href="/login"
            className="w-full rounded-sm bg-marigold-500 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:bg-marigold-600 hover:shadow active:scale-[0.98] sm:w-auto"
          >
            Get started - it's free
          </Link>
          
            href="#how-it-works"
            className="w-full rounded-sm border border-line bg-surface px-6 py-3 text-sm font-medium text-ink transition-colors hover:border-ink-faint hover:bg-paper sm:w-auto"
          >
            See how it works
          </a>
        </div>
        <p className="mt-4 text-xs text-ink-faint">
          No password required - sign in with a one-time code sent to your email.
        </p>
      </div>
    </section>
  );
}
