import Link from "next/link";

export function MarketingNav() {
  return (
    <header className="border-b border-line bg-paper/80 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
        <Link href="/" className="font-display text-xl text-ink">
          WealthOS <span className="text-marigold-500">AI</span>
        </Link>
        <nav className="hidden items-center gap-8 text-sm text-ink-soft md:flex">
          <a href="#modules" className="hover:text-ink">
            Modules
          </a>
          <a href="#ai" className="hover:text-ink">
            AI features
          </a>
          <a href="#how-it-works" className="hover:text-ink">
            How it works
          </a>
          <a href="#security" className="hover:text-ink">
            Security
          </a>
        </nav>
        <div className="flex items-center gap-3">
          <Link href="/login" className="hidden text-sm font-medium text-ink-soft hover:text-ink sm:block">
            Log in
          </Link>
          <Link
            href="/login"
            className="rounded-sm bg-marigold-500 px-4 py-2 text-sm font-medium text-white shadow-sm transition-all duration-150 hover:bg-marigold-600 hover:shadow active:scale-[0.98]"
          >
            Get started
          </Link>
        </div>
      </div>
    </header>
  );
}
