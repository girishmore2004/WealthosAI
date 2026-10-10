// An accessible progress bar: exposes its value to assistive technology (role="progressbar") and always
// pairs the bar with text elsewhere, so progress never depends on colour alone. The fill is clamped to
// 0–100% visually, but the real number is never hidden — a reached target can read 120%.
export function ProgressBar({ percent, label, tone = "gain" }: { percent: number | null; label: string; tone?: "gain" | "warning" }) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent === null ? undefined : Math.round(Math.min(100, Math.max(0, percent)))}
      aria-valuetext={percent === null ? "No target set" : `${percent}%`}
      className="h-2.5 w-full overflow-hidden rounded-full bg-surface-muted"
    >
      <div className={`h-full rounded-full transition-all ${tone === "warning" ? "bg-marigold-500" : "bg-gain"}`} style={{ width: `${clamped}%` }} />
    </div>
  );
}
