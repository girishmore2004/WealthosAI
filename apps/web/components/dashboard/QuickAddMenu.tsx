"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { CategoryDTO } from "@wealthos/types";
import { api } from "@/lib/api-client";
import { QuickExpenseDialog } from "@/components/expenses/QuickExpenseDialog";

const LINKS: Array<{ href: string; label: string }> = [
  { href: "/money/income", label: "Add income" },
  { href: "/money/investments", label: "Add investment" },
  { href: "/money/emergency-fund", label: "Add to emergency fund" },
  { href: "/money/receivables", label: "Lend money (receivable)" },
];

// The "+" quick action: one place to start any money entry. Expense opens the quick-expense dialog
// right here; the others go to the page that owns that kind of entry, so each kind of money keeps
// its own form and its own rules. Escape closes the menu and focus returns to the button.
export function QuickAddMenu() {
  const [open, setOpen] = useState(false);
  const [expenseOpen, setExpenseOpen] = useState(false);
  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const button = useRef<HTMLButtonElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!expenseOpen || categories.length > 0) return;
    api.expenses.categories().then(setCategories).catch(() => setCategories([]));
  }, [expenseOpen, categories.length]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md bg-marigold-500 px-3.5 py-2 text-sm font-medium text-white shadow-card hover:bg-marigold-600"
      >
        <span aria-hidden="true">+</span> Add
      </button>
      {open && (
        <div role="menu" aria-label="Quick add" className="absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-md border border-line bg-surface shadow-card">
          <button
            type="button"
            role="menuitem"
            className="block w-full px-4 py-2.5 text-left text-sm text-ink hover:bg-surface-muted"
            onClick={() => {
              setOpen(false);
              setExpenseOpen(true);
            }}
          >
            Add expense
          </button>
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} role="menuitem" className="block px-4 py-2.5 text-sm text-ink hover:bg-surface-muted" onClick={() => setOpen(false)}>
              {l.label}
            </Link>
          ))}
        </div>
      )}
      <QuickExpenseDialog open={expenseOpen} onClose={() => setExpenseOpen(false)} categories={categories} />
    </div>
  );
}
