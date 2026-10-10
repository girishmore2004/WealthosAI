import type { ExpenseAnalyticsDTO } from "@wealthos/types";
import { formatINR } from "@/lib/format";

// Spending that went UP is shown in the loss colour and spending that went DOWN in the gain colour,
// always with an arrow and a sign as well, so the direction never depends on colour alone.
export function ChangeBadge({ percent }: { percent: number | null }) {
  if (percent === null) return <span className="text-xs text-ink-faint">new</span>;
  if (percent === 0) return <span className="text-xs text-ink-faint">no change</span>;
  const up = percent > 0;
  return (
    <span className={`text-xs ${up ? "text-loss" : "text-gain"}`}>
      {up ? "▲ +" : "▼ "}
      {percent.toFixed(1)}%
    </span>
  );
}

// Level 2: a category-by-category breakdown for the selected period. Every row is a button that
// opens that category's drill-down.
export function CategoryList({
  categories,
  onSelect,
}: {
  categories: ExpenseAnalyticsDTO["categories"];
  onSelect: (categoryId: string, name: string) => void;
}) {
  if (categories.length === 0) return <p className="text-sm text-ink-faint">No spending in this period.</p>;
  return (
    <ul>
      {categories.map((c, i) => (
        <li key={c.categoryId} className={i !== categories.length - 1 ? "ledger-rule" : ""}>
          <button
            type="button"
            onClick={() => onSelect(c.categoryId, c.name)}
            className="flex w-full items-center gap-3 rounded-md px-1 py-3 text-left transition-colors hover:bg-surface-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-marigold-500"
            aria-label={`${c.name}, ${formatINR(c.total)}. Open category details`}
          >
            <span className="w-7 text-center text-lg" aria-hidden="true">
              {c.icon ?? "•"}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm text-ink">{c.name}</span>
              <span className="block text-xs text-ink-faint">
                {c.sharePercent !== null ? `${c.sharePercent.toFixed(1)}% of spending` : ""} · {c.count} transaction{c.count === 1 ? "" : "s"}
              </span>
            </span>
            <span className="text-right">
              <span className="money block text-sm text-ink">{formatINR(c.total)}</span>
              <ChangeBadge percent={c.changePercent} />
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
