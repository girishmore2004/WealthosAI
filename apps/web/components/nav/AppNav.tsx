
"use client";

import { ReactNode, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { AlertsBell } from "./AlertsBell";
import { ThemeToggle } from "@/components/ui/ThemeToggle";

type IconName = "home" | "money" | "goals" | "protect" | "agent" | "reports" | "more";

type NavItem = { label: string; href: string; icon: IconName };
type NavGroup = { title: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Overview",
    items: [{ label: "Home", href: "/dashboard", icon: "home" }],
  },
  {
    title: "Wealth",
    items: [
      { label: "Money", href: "/money/income", icon: "money" },
      { label: "Goals", href: "/goals", icon: "goals" },
      { label: "Protect", href: "/protect", icon: "protect" },
      { label: "Reports", href: "/reports", icon: "reports" },
    ],
  },
  {
    title: "AI",
    items: [{ label: "AI Agent", href: "/ai-agent", icon: "agent" }],
  },
  {
    title: "Account",
    items: [{ label: "More", href: "/settings", icon: "more" }],
  },
];

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: <path d="M3 11l9-8 9 8M5 10v10h14V10" />,
  money: (
    <>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  goals: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1" />
    </>
  ),
  protect: (
    <path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" />
  ),
  agent: (
    <>
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m0-12.72-1.42 1.42m-9.88 9.88-1.42 1.42" />
      <circle cx="12" cy="12" r="6" />
      <path d="M9.5 13.5s.8 1 2.5 1 2.5-1 2.5-1M10 10h.01M14 10h.01" />
    </>
  ),
  reports: (
    <>
      <path d="M14 3H6a1 1 0 00-1 1v16a1 1 0 001 1h12a1 1 0 001-1V8l-5-5z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="19" cy="12" r="1.2" />
    </>
  ),
};

function NavIcon({ name }: { name: IconName }) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}

function isActive(pathname: string | null, href: string) {
  if (href === "/money/income") {
    return pathname?.startsWith("/money") ?? false;
  }

  if (href === "/ai-agent") {
    return pathname === "/ai-agent" || pathname?.startsWith("/ai-agent/") === true;
  }

  return pathname === href;
}

export function AppNav() {
  const pathname = usePathname();
  const { user, logout } = useAuth();

  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  useEffect(() => {
    setCollapsed(
      document.documentElement.getAttribute("data-sidebar") === "collapsed"
    );
  }, []);

  const toggleCollapsed = useCallback(() => {
    const next =
      document.documentElement.getAttribute("data-sidebar") !== "collapsed";

    if (next) {
      document.documentElement.setAttribute("data-sidebar", "collapsed");
    } else {
      document.documentElement.removeAttribute("data-sidebar");
    }

    try {
      localStorage.setItem(
        "wealthos-sidebar",
        next ? "collapsed" : "expanded"
      );
    } catch {
      // Sidebar preference is optional.
    }

    setCollapsed(next);
  }, []);

  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!mobileOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };

    document.addEventListener("keydown", onKey);

    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  const labelClass = collapsed ? "lg:hidden" : "";

  return (
    <>
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          aria-hidden="true"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        id="app-sidebar"
        aria-label="Primary"
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-line bg-sidebar transition-transform duration-200 lg:z-30 lg:w-[var(--sidebar-w)] lg:translate-x-0 lg:transition-[width] ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div
          className={`flex h-16 shrink-0 items-center gap-2 border-b border-line px-4 ${
            collapsed ? "lg:justify-center lg:px-0" : ""
          }`}
        >
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 font-display text-lg tracking-tight text-ink"
            aria-label="WealthOS AI home"
          >
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-marigold-500 text-sm font-semibold text-onaccent">
              W
            </span>

            <span className={labelClass}>
              WealthOS <span className="text-marigold-600">AI</span>
            </span>
          </Link>
        </div>

        <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.title}>
              <p
                className={`stat-label mb-1.5 px-3 ${
                  collapsed ? "lg:sr-only" : ""
                }`}
              >
                {group.title}
              </p>

              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = isActive(pathname, item.href);

                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? "page" : undefined}
                        title={collapsed ? item.label : undefined}
                        className={`nav-item ${
                          collapsed ? "lg:justify-center lg:px-0" : ""
                        }`}
                      >
                        <NavIcon name={item.icon} />
                        <span className={labelClass}>{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="hidden shrink-0 border-t border-line p-3 lg:block">
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-pressed={collapsed}
            aria-controls="app-sidebar"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            className={`nav-item w-full ${
              collapsed ? "justify-center px-0" : ""
            }`}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className={collapsed ? "rotate-180" : ""}
            >
              <path d="M11 17l-5-5 5-5M18 17l-5-5 5-5" />
            </svg>

            {!collapsed && <span>Collapse</span>}
          </button>
        </div>
      </aside>

      <header className="sticky top-0 z-20 border-b border-line bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-3 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setMobileOpen((open) => !open)}
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            aria-expanded={mobileOpen}
            aria-controls="app-sidebar"
            className="flex h-11 w-11 items-center justify-center rounded-md text-ink-soft transition-colors hover:bg-surface-muted hover:text-ink lg:hidden"
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

          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <AlertsBell />
            <ThemeToggle />

            <span className="hidden max-w-[12rem] truncate pl-2 text-sm text-ink-soft sm:inline">
              {user?.name ?? user?.email}
            </span>

            <button
              onClick={() => logout()}
              className="rounded-md px-2.5 py-1.5 text-sm text-ink-faint transition-colors hover:bg-surface-muted hover:text-ink"
            >
              Log out
            </button>
          </div>
        </div>
      </header>
    </>
  );
}
