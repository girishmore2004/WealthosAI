// Formats a decimal-string or number as Indian-grouped rupees, e.g. "1,24,500".
// Used everywhere money is displayed so figures are consistent and scannable.
export function formatINR(value: string | number, opts?: { showSymbol?: boolean }): string {
  const amount = typeof value === "string" ? parseFloat(value) : value;
  const formatted = new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: 0,
  }).format(Math.round(amount));
  return opts?.showSymbol === false ? formatted : `\u20B9${formatted}`;
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}
