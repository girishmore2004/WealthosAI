import Link from "next/link";

export function ClosingCta() {
  return (
    <section className="border-t border-line bg-surface py-16">
      <div className="mx-auto max-w-2xl px-4 text-center sm:px-6">
        <h2 className="font-display text-3xl text-ink">Ready to see your full financial picture?</h2>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Sign in with your email — no password, no card required.
        </p>
        <Link
          href="/login"
          className="mt-6 inline-block rounded-sm bg-marigold-500 px-6 py-3 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:bg-marigold-600 hover:shadow active:scale-[0.98]"
        >
          Get started — it&apos;s free
        </Link>
      </div>
    </section>
  );
}

export function Footer() {
  return (
    <footer className="bg-paper">
      <div className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-4 sm:flex-row">
          <p className="font-display text-lg text-ink">
            WealthOS <span className="text-marigold-500">AI</span>
          </p>
          <div className="flex items-center gap-6 text-sm text-ink-soft">
            <a href="#modules" className="hover:text-ink">
              Modules
            </a>
            <a href="#ai" className="hover:text-ink">
              AI features
            </a>
            <Link href="/login" className="hover:text-ink">
              Log in
            </Link>
          </div>
        </div>
        <p className="mt-6 text-center text-xs leading-relaxed text-ink-faint sm:text-left">
          WealthOS AI provides projections and explainable, rules-based insights based
          on the data you enter. It is not financial, tax, or legal advice, and nothing
          in this product guarantees future outcomes.
        </p>
      </div>
    </footer>
  );
}
