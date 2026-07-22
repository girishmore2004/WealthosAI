"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { label: "Income", href: "/money/income" },
  { label: "Expenses", href: "/money/expenses" },
  { label: "Investments", href: "/money/investments" },
  { label: "Property", href: "/money/property" },
  { label: "Business", href: "/money/business" },
  { label: "Loans", href: "/money/loans" },
  { label: "Tax", href: "/money/tax" },
  { label: "Retirement", href: "/money/retirement" },
  { label: "Subscriptions", href: "/money/subscriptions" },
  { label: "Documents", href: "/money/documents" },
  { label: "What-If", href: "/money/simulator" },
  { label: "Household", href: "/money/household" },
];

export default function MoneyLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div>
      <div className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((tab) => {
          const active = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              className={`shrink-0 whitespace-nowrap px-3 py-2 text-sm ${
                active ? "border-b-2 border-marigold-500 text-ink" : "text-ink-faint hover:text-ink-soft"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      {children}
    </div>
  );
}
