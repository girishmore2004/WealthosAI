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
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <Link href="/dashboard" className="font-display text-lg text-ink" onClick={() => setMobileOpen(false)}>
          WealthOS AI
        </Link>

        <nav className="hidden gap-1 md:flex">
          {NAV_ITEMS.map((item) => {
            if (!item.enabled) {
              return (
                <span
                  key={item.href}
                  title="Coming in a later phase"
                  className="cursor-default rounded-sm px-3 py-1.5 text-sm text-ink-faint/60"
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
                className={`rounded-sm px-3 py-1.5 text-sm ${
                  active ? "bg-marigold-50 text-marigold-600" : "text-ink-soft hover:text-ink"
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
          <button onClick={() => logout()} className="hidden text-sm text-ink-faint hover:text-ink md:inline">
            Log out
          </button>
          <button
            onClick={() => setMobileOpen((o) => !o)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            className="flex h-11 w-11 items-center justify-center rounded-sm text-ink-soft hover:text-ink md:hidden"
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
        <nav className="border-t border-line bg-surface md:hidden">
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
                className={`block px-4 py-3 text-sm ${active ? "text-marigold-600" : "text-ink-soft"}`}
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
