"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AlertsBell } from "./AlertsBell";

// All top-level IA items are now built.
const NAV_ITEMS = [
  { label: "Home", href: "/dashboard", enabled: true },
  { label: "Money", href: "/money/income", enabled: true },
  { label: "Goals", href: "/goals", enabled: true },
  { label: "Protect", href: "/protect", enabled: true },
  { label: "AI Coach", href: "/coach", enabled: true },
  { label: "AI Search", href: "/ai-search", enabled: true },
  { label: "Scenario Studio", href: "/scenario-studio", enabled: true },
  { label: "Copilot Ingestion", href: "/copilot-ingestion", enabled: true },
  { label: "Reports", href: "/reports", enabled: true },
  { label: "More", href: "/settings", enabled: true },
];

function isActive(pathname: string | null, href: string) {
  return href === "/money/income" ? pathname?.startsWith("/money") : pathname === href;
}

export function AppNav() {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 border-b border-line bg-surface/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 font-display text-lg tracking-tight text-ink"
          onClick={() => setMobileOpen(false)}
        >
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-ink text-xs font-semibold text-paper">
            W
          </span>
          WealthOS AI
        </Link>

        <nav className="hidden gap-0.5 lg:flex">
          {NAV_ITEMS.map((item) => {
            if (!item.enabled) {
              return (
                <span
                  key={item.href}
                  title="Coming in a later phase"
                  className="cursor-default rounded-md px-3 py-1.5 text-sm text-ink-faint/60"
                >
                  {item.label}
                </span>
              );
            }
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                  active ? "bg-marigold-50 font-medium text-marigold-600" : "text-ink-soft hover:bg-surface-muted hover:text-ink"
                }`}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="flex items-center gap-2 sm:gap-3">
          <AlertsBell />
          <span className="hidden text-sm text-ink-soft sm:inline">{user?.name ?? user?.email}</span>
          <button
            onClick={() => logout()}
            className="hidden rounded-md px-2 py-1.5 text-sm text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink lg:inline"
          >
            Log out
          </button>
          <button
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft hover:bg-surface-muted hover:text-ink lg:hidden"
          >
            {mobileOpen ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M3 6h18M3 12h18M3 18h18" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {mobileOpen && (
        <nav className="border-t border-line bg-surface lg:hidden">
          {NAV_ITEMS.map((item) => {
            if (!item.enabled) {
              return (
                <span key={item.href} className="block px-4 py-3 text-sm text-ink-faint/60">
                  {item.label} <span className="text-[11px]">(coming soon)</span>
                </span>
              );
            }
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setMobileOpen(false)}
                className={`block px-4 py-3 text-sm ${active ? "font-medium text-marigold-600" : "text-ink-soft"}`}
              >
                {item.label}
              </Link>
            );
          })}
          <button
            onClick={() => {
              setMobileOpen(false);
              logout();
            }}
            className="block w-full border-t border-line px-4 py-3 text-left text-sm text-ink-faint"
          >
            Log out
          </button>
        </nav>
      )}
    </header>
  );
}
