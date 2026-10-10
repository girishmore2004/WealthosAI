"use client";

import { useId, useState } from "react";
import type { CategoryDTO } from "@wealthos/types";
import { Input } from "@/components/ui/Input";
import {
  DEFAULT_FILTERS,
  ExpenseFilterState,
  PAYMENT_METHOD_OPTIONS,
  PERIOD_OPTIONS,
  SORT_OPTIONS,
  TYPE_OPTIONS,
  activeFilterCount,
} from "@/lib/expense-filters";

const selectClass =
  "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink transition-colors focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";

function Labeled({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        {label}
      </label>
      {children}
    </div>
  );
}

// Date · Category · Type · Payment method · Sort. On phones the controls collapse behind a
// "Filters" button (with a count of what is active) so they don't push the list off-screen.
export function ExpenseFilters({
  value,
  onChange,
  categories,
}: {
  value: ExpenseFilterState;
  onChange: (next: ExpenseFilterState) => void;
  categories: CategoryDTO[];
}) {
  const uid = useId();
  const id = (n: string) => `${uid}-${n}`;
  const [open, setOpen] = useState(false);
  const count = activeFilterCount(value);
  const set = (patch: Partial<ExpenseFilterState>) => onChange({ ...value, ...patch });

  return (
    <div>
      <div className="flex items-center justify-between sm:hidden">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls={id("panel")}
          className="rounded-md border border-line px-3 py-2 text-sm text-ink"
        >
          Filters{count > 0 ? ` (${count})` : ""}
        </button>
        {count > 0 && (
          <button type="button" onClick={() => onChange(DEFAULT_FILTERS)} className="text-xs text-marigold-600 hover:underline">
            Clear all
          </button>
        )}
      </div>

      <div id={id("panel")} className={`${open ? "mt-3 grid" : "hidden"} gap-3 sm:mt-0 sm:grid sm:grid-cols-2 lg:grid-cols-5`}>
        <Labeled id={id("period")} label="Date">
          <select id={id("period")} value={value.period} onChange={(e) => set({ period: e.target.value as ExpenseFilterState["period"] })} className={selectClass}>
            {PERIOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled id={id("category")} label="Category">
          <select id={id("category")} value={value.categoryId} onChange={(e) => set({ categoryId: e.target.value })} className={selectClass}>
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled id={id("type")} label="Type">
          <select id={id("type")} value={value.type} onChange={(e) => set({ type: e.target.value as ExpenseFilterState["type"] })} className={selectClass}>
            {TYPE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled id={id("pay")} label="Payment method">
          <select id={id("pay")} value={value.paymentMethod} onChange={(e) => set({ paymentMethod: e.target.value })} className={selectClass}>
            <option value="">All methods</option>
            {PAYMENT_METHOD_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Labeled>

        <Labeled id={id("sort")} label="Sort by">
          <select id={id("sort")} value={value.sort} onChange={(e) => set({ sort: e.target.value as ExpenseFilterState["sort"] })} className={selectClass}>
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Labeled>

        {value.period === "CUSTOM" && (
          <>
            <Labeled id={id("from")} label="From">
              <Input id={id("from")} type="date" value={value.from} max={value.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            </Labeled>
            <Labeled id={id("to")} label="To">
              <Input id={id("to")} type="date" value={value.to} min={value.from || undefined} onChange={(e) => set({ to: e.target.value })} />
            </Labeled>
          </>
        )}
      </div>
    </div>
  );
}
