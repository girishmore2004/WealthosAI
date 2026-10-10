// Every important figure says what KIND of fact it is, so an actual number is never mistaken for a
// forecast, a projection or a target (spec Part 34). ACTUAL is deliberately quiet — it is the
// normal case — while anything that is NOT a recorded fact is tinted so it stands out.
export type FactBasis = "ACTUAL" | "FORECAST" | "PROJECTED" | "TARGET" | "ESTIMATED";

const STYLE: Record<FactBasis, string> = {
  ACTUAL: "border-line text-ink-faint",
  FORECAST: "border-marigold-400/60 bg-marigold-50 text-marigold-600",
  PROJECTED: "border-marigold-400/60 bg-marigold-50 text-marigold-600",
  ESTIMATED: "border-marigold-400/60 bg-marigold-50 text-marigold-600",
  TARGET: "border-ink-faint/50 bg-surface-muted text-ink-soft",
};

export function BasisTag({ basis = "ACTUAL" }: { basis?: FactBasis }) {
  return (
    <span
      className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STYLE[basis]}`}
      title={basis === "ACTUAL" ? "Recorded transactions" : `${basis.charAt(0)}${basis.slice(1).toLowerCase()} — not a recorded transaction`}
    >
      {basis}
    </span>
  );
}
