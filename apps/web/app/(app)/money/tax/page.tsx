"use client";

import { useEffect, useState, FormEvent } from "react";
import type { TaxDeductionDTO, TaxEstimateDTO, TaxSection } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

const SECTIONS: TaxSection[] = [
  "SECTION_80C",
  "SECTION_80D",
  "SECTION_80CCD_1B",
  "HRA",
  "HOME_LOAN_INTEREST",
  "SECTION_80TTA",
  "SECTION_80E",
  "OTHER",
];

function currentFinancialYear(): string {
  const now = new Date();
  const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

export default function TaxPage() {
  const financialYear = currentFinancialYear();
  const [deductions, setDeductions] = useState<TaxDeductionDTO[]>([]);
  const [estimate, setEstimate] = useState<TaxEstimateDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [section, setSection] = useState<TaxSection>("SECTION_80C");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const load = () => {
    Promise.all([api.tax.deductions(financialYear), api.tax.estimate(financialYear)])
      .then(([d, e]) => {
        setDeductions(d);
        setEstimate(e);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load tax data."))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.tax.addDeduction({ section, description, amount: parseFloat(amount), financialYear });
      setDescription("");
      setAmount("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not save this deduction.");
    } finally {
      setSubmitting(false);
    }
  };

  const onDelete = async (id: string) => {
    await api.tax.removeDeduction(id);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Tax planning · FY {financialYear}</h1>
        <p className="text-sm text-ink-soft">
          An educational estimate to compare regimes and track deductions — not a substitute for a CA or the
          official IT department calculator.
        </p>
      </div>

      {loading && !estimate && (
        <Card>
          <p className="text-sm text-ink-faint">Calculating your tax estimate…</p>
        </Card>
      )}

      {estimate && (
        <Card>
          <div className="grid gap-6 sm:grid-cols-2">
            <div className={`rounded-sm border p-4 ${estimate.recommendedRegime === "OLD" ? "border-marigold-500" : "border-line"}`}>
              <p className="text-xs uppercase tracking-wide text-ink-faint">Old regime</p>
              <p className="mt-2 money text-xl text-ink">{formatINR(estimate.oldRegime.taxPayable)}</p>
              <p className="mt-1 text-xs text-ink-faint">
                Taxable income: <span className="money">{formatINR(estimate.oldRegime.taxableIncome)}</span>
              </p>
            </div>
            <div className={`rounded-sm border p-4 ${estimate.recommendedRegime === "NEW" ? "border-marigold-500" : "border-line"}`}>
              <p className="text-xs uppercase tracking-wide text-ink-faint">New regime</p>
              <p className="mt-2 money text-xl text-ink">{formatINR(estimate.newRegime.taxPayable)}</p>
              <p className="mt-1 text-xs text-ink-faint">
                Taxable income: <span className="money">{formatINR(estimate.newRegime.taxableIncome)}</span>
              </p>
            </div>
          </div>
          <p className="mt-4 text-sm text-ink">
            Based on income logged so far, the <span className="font-medium">{estimate.recommendedRegime.toLowerCase()} regime</span>{" "}
            looks better by <span className="money">{formatINR(estimate.savingsFromRecommendedRegime)}</span> this year.
          </p>
          <p className="mt-3 text-[11px] text-ink-faint">
            Projection only, based on simplified slabs and the deductions logged below — not tax advice.
          </p>
        </Card>
      )}

      <Card title="Add a deduction">
        <form onSubmit={onSubmit} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <select
            value={section}
            onChange={(e) => setSection(e.target.value as TaxSection)}
            className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
          >
            {SECTIONS.map((s) => (
              <option key={s} value={s}>
                {s.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <Input placeholder="Description (e.g. ELSS SIP)" value={description} onChange={(e) => setDescription(e.target.value)} required />
          <Input
            type="number"
            min="0"
            step="0.01"
            placeholder="Amount (₹)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
            className="money"
          />
          <Button type="submit" disabled={submitting}>
            {submitting ? "Saving…" : "Add deduction"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-loss">{error}</p>}
      </Card>

      {estimate && (
        <Card title="Deductions by section">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[400px] text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-ink-faint">
                  <th className="pb-2">Section</th>
                  <th className="pb-2 text-right">Used</th>
                  <th className="pb-2 text-right">Limit</th>
                  <th className="pb-2 text-right">Room left</th>
                </tr>
              </thead>
              <tbody>
                {estimate.deductionsBySection.map((row) => (
                  <tr key={row.section} className="ledger-rule">
                    <td className="py-2 text-ink">{row.section.replace(/_/g, " ")}</td>
                    <td className="money py-2 text-right">{formatINR(row.used)}</td>
                    <td className="money py-2 text-right">{row.limit === "No fixed cap" ? row.limit : formatINR(row.limit)}</td>
                    <td className="money py-2 text-right">{formatINR(row.remainingRoom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {estimate && estimate.yearEndChecklist.length > 0 && (
        <Card title="Year-end checklist">
          <ul className="space-y-2 text-sm text-ink-soft">
            {estimate.yearEndChecklist.map((item, i) => (
              <li key={i} className="border-l-2 border-marigold-500 pl-3">
                {item}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card title="All deductions logged">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : deductions.length === 0 ? (
          <p className="text-sm text-ink-faint">No deductions logged yet for FY {financialYear}.</p>
        ) : (
          <ul>
            {deductions.map((d, i) => (
              <li key={d.id} className={`flex items-center justify-between py-2 text-sm ${i !== deductions.length - 1 ? "ledger-rule" : ""}`}>
                <div>
                  <p className="text-ink">{d.description}</p>
                  <p className="text-xs text-ink-faint">{d.section.replace(/_/g, " ")}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="money text-ink">{formatINR(d.amount)}</span>
                  <button onClick={() => onDelete(d.id)} className="text-xs text-ink-faint hover:text-loss">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
