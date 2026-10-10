"use client";

import { FormEvent, useEffect, useId, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { PortfolioProjectionDTO, ProjectionDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { BasisTag } from "@/components/ui/BasisTag";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

const RATE_CHIPS = [8, 10, 12, 15];
const FREQUENCIES = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every 2 weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "YEARLY", label: "Yearly" },
] as const;

const axis = { fontSize: 11, fill: "#8A93A6" };
const compact = (v: number) => (Math.abs(v) >= 100000 ? `${(v / 100000).toFixed(v >= 1000000 ? 0 : 1)}L` : Math.abs(v) >= 1000 ? `${Math.round(v / 1000)}k` : String(v));
const selectClass = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink focus:border-marigold-500 focus:ring-1 focus:ring-marigold-500/30";

type Mode = "PORTFOLIO" | "WHATIF";
type Result = Pick<ProjectionDTO, "scenarios" | "curve" | "disclaimer">;

// Level 5 of the page: what the money could become. EVERYTHING here is a projection from an
// assumption the user chose — it is tagged PROJECTED, the disclaimer is always shown with the numbers,
// the actual value today is shown beside (never replaced by) the projection, and all the maths runs on
// the server. Changing the assumed return re-asks the server; nothing is computed in the browser.
export function ProjectionPanel({ onChange }: { onChange?: (rate: number, projection: PortfolioProjectionDTO | null) => void }) {
  const uid = useId();
  const [mode, setMode] = useState<Mode>("PORTFOLIO");
  const [rate, setRate] = useState(12);
  const [customRate, setCustomRate] = useState("");
  const [rateError, setRateError] = useState<string | null>(null);

  // What-if inputs (kept as text so the user can type freely).
  const [startValue, setStartValue] = useState("0");
  const [contribution, setContribution] = useState("10000");
  const [frequency, setFrequency] = useState<(typeof FREQUENCIES)[number]["value"]>("MONTHLY");

  const [portfolio, setPortfolio] = useState<PortfolioProjectionDTO | null>(null);
  const [whatIf, setWhatIf] = useState<ProjectionDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (mode !== "PORTFOLIO") return;
    let active = true;
    setLoading(true);
    setError(null);
    api.investments
      .portfolioProjection({ annualReturn: rate })
      .then((p) => {
        if (!active) return;
        setPortfolio(p);
        onChange?.(rate, p);
      })
      .catch((err) => active && setError(err instanceof ApiError ? err.message : "Could not load the projection."))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, rate]);

  const runWhatIf = async (e?: FormEvent) => {
    e?.preventDefault();
    setError(null);
    const sv = parseFloat(startValue);
    const c = parseFloat(contribution);
    if (!Number.isFinite(sv) || sv < 0 || !Number.isFinite(c) || c < 0) {
      setError("Enter amounts of zero or more.");
      return;
    }
    setLoading(true);
    try {
      setWhatIf(await api.investments.projection({ annualReturn: rate, currentValue: sv, contribution: c, frequency }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not calculate the projection.");
    } finally {
      setLoading(false);
    }
  };

  // The what-if result is stale the moment the assumed return changes, so re-run it.
  useEffect(() => {
    if (mode === "WHATIF") void runWhatIf();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, rate]);

  const applyCustom = (e: FormEvent) => {
    e.preventDefault();
    const v = parseFloat(customRate);
    if (!Number.isFinite(v) || v < 0 || v > 100) {
      setRateError("Enter a return between 0 and 100.");
      return;
    }
    setRateError(null);
    setRate(v);
  };

  const result: Result | null = mode === "PORTFOLIO" ? portfolio : whatIf;
  const disclaimer = result?.disclaimer ?? "A projection, not a promise: it assumes the same return every year. Real returns vary and can be negative.";
  const chart = result?.curve.map((c) => ({ year: c.year, principal: Number(c.principal), projected: Number(c.projectedValue) })) ?? [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Projection type" className="inline-flex overflow-hidden rounded-md border border-line text-sm">
          {(
            [
              ["PORTFOLIO", "My portfolio"],
              ["WHATIF", "What-if calculator"],
            ] as const
          ).map(([value, text]) => (
            <button
              key={value}
              role="tab"
              type="button"
              aria-selected={mode === value}
              onClick={() => setMode(value)}
              className={`px-3 py-1.5 ${mode === value ? "bg-marigold-50 font-medium text-ink" : "text-ink-soft hover:bg-surface-muted"}`}
            >
              {text}
            </button>
          ))}
        </div>
        <BasisTag basis="PROJECTED" />
      </div>

      <fieldset>
        <legend className="mb-1 text-xs font-medium text-ink-soft">
          {mode === "PORTFOLIO" ? "Assumed return for holdings without their own (per year)" : "Assumed return (per year)"}
        </legend>
        <div className="flex flex-wrap items-center gap-2">
          {RATE_CHIPS.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={rate === r}
              onClick={() => {
                setRate(r);
                setCustomRate("");
                setRateError(null);
              }}
              className={`rounded-full border px-3 py-1 text-sm ${rate === r ? "border-marigold-500 bg-marigold-50 font-medium text-ink" : "border-line text-ink-soft hover:bg-surface-muted"}`}
            >
              {r}%
            </button>
          ))}
          <form onSubmit={applyCustom} className="flex items-center gap-2" noValidate>
            <label htmlFor={`${uid}-custom`} className="sr-only">
              Custom return in percent
            </label>
            <Input id={`${uid}-custom`} type="number" inputMode="decimal" step="0.1" min="0" max="100" value={customRate} onChange={(e) => setCustomRate(e.target.value)} placeholder="Other %" className="w-24" />
            <Button type="submit" variant="secondary" size="sm">
              Apply
            </Button>
          </form>
        </div>
        <p className="mt-1 text-xs text-ink-faint">Currently assuming {rate}% a year.</p>
        {rateError && (
          <p role="alert" className="mt-1 text-xs text-loss">
            {rateError}
          </p>
        )}
      </fieldset>

      {mode === "WHATIF" && (
        <form onSubmit={runWhatIf} className="grid gap-3 sm:grid-cols-4" noValidate>
          <div>
            <label htmlFor={`${uid}-start`} className="mb-1 block text-xs font-medium text-ink-soft">
              Starting amount (₹)
            </label>
            <Input id={`${uid}-start`} type="number" inputMode="decimal" min="0" value={startValue} onChange={(e) => setStartValue(e.target.value)} className="money" />
          </div>
          <div>
            <label htmlFor={`${uid}-contrib`} className="mb-1 block text-xs font-medium text-ink-soft">
              Added each time (₹)
            </label>
            <Input id={`${uid}-contrib`} type="number" inputMode="decimal" min="0" value={contribution} onChange={(e) => setContribution(e.target.value)} className="money" />
          </div>
          <div>
            <label htmlFor={`${uid}-freq`} className="mb-1 block text-xs font-medium text-ink-soft">
              How often
            </label>
            <select id={`${uid}-freq`} value={frequency} onChange={(e) => setFrequency(e.target.value as typeof frequency)} className={selectClass}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-end">
            <Button type="submit">Calculate</Button>
          </div>
        </form>
      )}

      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}

      {mode === "PORTFOLIO" && portfolio && (
        <div className="rounded-md border border-line bg-surface-muted p-3 text-sm">
          <p className="text-ink">
            <span className="text-ink-soft">Worth today (actual):</span> <span className="money">{formatINR(portfolio.actual.currentValue)}</span>
            <span className="ml-2 text-xs text-ink-faint">across {portfolio.actual.holdings} holding{portfolio.actual.holdings === 1 ? "" : "s"}</span>
          </p>
          {portfolio.excludedCount > 0 && (
            <p className="mt-1 text-xs text-ink-soft">
              {portfolio.excludedCount} holding{portfolio.excludedCount === 1 ? " is" : "s are"} not in the projection because no return was assumed for {portfolio.excludedCount === 1 ? "it" : "them"}.
            </p>
          )}
          {portfolio.holdings.some((h) => h.rateSource === "INVESTMENT") && (
            <p className="mt-1 text-xs text-ink-faint">Holdings with their own expected return use it instead of the rate above.</p>
          )}
        </div>
      )}

      {loading && !result ? (
        <p className="text-sm text-ink-faint">Calculating…</p>
      ) : !result || result.scenarios.length === 0 ? (
        <p className="text-sm text-ink-faint">
          {mode === "PORTFOLIO" ? "Add a holding to see where it could be in 5 to 25 years." : "Enter amounts and choose Calculate."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-sm">
              <caption className="sr-only">Projected value at each horizon, assuming {rate}% a year</caption>
              <thead>
                <tr className="text-left text-xs text-ink-faint">
                  <th className="py-2 pr-3 font-medium">In</th>
                  <th className="py-2 pr-3 text-right font-medium">You put in</th>
                  <th className="py-2 pr-3 text-right font-medium">Without growth</th>
                  <th className="py-2 pr-3 text-right font-medium">Projected value</th>
                  <th className="py-2 text-right font-medium">Projected growth</th>
                </tr>
              </thead>
              <tbody>
                {result.scenarios.map((s) => (
                  <tr key={s.years} className="ledger-rule">
                    <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">
                      {s.years} years
                    </th>
                    <td className="money py-2 pr-3 text-right text-ink-soft">{formatINR(s.totalContributions)}</td>
                    <td className="money py-2 pr-3 text-right text-ink-soft">{formatINR(s.principal)}</td>
                    <td className="money py-2 pr-3 text-right font-medium text-ink">{formatINR(s.projectedValue)}</td>
                    <td className="money py-2 text-right text-gain">+{formatINR(s.projectedGain)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ width: "100%", height: 240 }} role="img" aria-label="Projected growth over the years">
            <ResponsiveContainer>
              <LineChart data={chart} margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
                <CartesianGrid vertical={false} stroke="#E9E5D8" />
                <XAxis dataKey="year" tick={axis} axisLine={false} tickLine={false} tickFormatter={(y: number) => `${y}y`} />
                <YAxis tick={axis} axisLine={false} tickLine={false} width={48} tickFormatter={compact} />
                <Tooltip formatter={(v: number, n: string) => [formatINR(v), n === "principal" ? "Without growth" : "Projected value"]} labelFormatter={(y: number) => `After ${y} years`} contentStyle={{ fontSize: 12, borderRadius: 8, borderColor: "#E9E5D8" }} />
                <Legend formatter={(v) => (v === "principal" ? "Without growth" : "Projected value")} wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="principal" stroke="#B9B29A" strokeWidth={2} dot={false} strokeDasharray="4 3" />
                <Line type="monotone" dataKey="projected" stroke="#D98F2B" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}

      <p className="text-xs text-ink-faint" role="note">
        {disclaimer}
      </p>
    </div>
  );
}
