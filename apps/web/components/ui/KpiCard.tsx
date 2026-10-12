import { ReactNode } from "react";

type KpiTone = "default" | "gain" | "loss";

const TONE_CLASS: Record<KpiTone, string> = {
  default: "text-ink",
  gain: "text-gain",
  loss: "text-loss",
};

// Compact KPI tile: small label, prominent tabular value, optional one-line context. Presentation
// only — callers pass an already-formatted value taken from real data, so nothing is invented here.
export function KpiCard({
  label,
  value,
  hint,
  tone = "default",
  accent = false,
  className = "",
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: KpiTone;
  /** Draws a thin accent rule on the left edge to mark the headline figure. */
  accent?: boolean;
  className?: string;
}) {
  return (
    <div className={`panel relative min-w-0 overflow-hidden p-4 ${className}`}>
      {accent && <span aria-hidden="true" className="absolute inset-y-0 left-0 w-0.5 bg-marigold-500" />}
      <p className="stat-label truncate">{label}</p>
      <p className={`stat-value mt-2 text-xl sm:text-2xl ${TONE_CLASS[tone]}`}>{value}</p>
      {hint && <p className="mt-1 text-[11px] text-ink-faint">{hint}</p>}
    </div>
  );
}
