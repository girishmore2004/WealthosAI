// Server-side counterpart to apps/web/lib/format.ts's formatINR — used wherever the
// backend needs to render a rupee amount into human-readable text (currently just the
// AI Coach's generated answers). Kept intentionally simple; the frontend does its own
// formatting for on-screen numeric display.
export function formatINR(value: number | string): string {
  const amount = typeof value === "string" ? parseFloat(value) : value;
  return `\u20B9${new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 }).format(Math.round(amount))}`;
}
