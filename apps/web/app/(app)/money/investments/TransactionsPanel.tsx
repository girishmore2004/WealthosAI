"use client";

import { useCallback, useEffect, useState } from "react";
import type { InvestmentCashflowType, InvestmentTransactionRowDTO, PagedInvestmentTransactionsDTO, PortfolioHoldingDTO } from "@wealthos/types";
import { api, ApiError, InvestmentTransactionParams } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

const selectClass = "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm text-ink";
const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

const TYPE_LABEL: Record<InvestmentCashflowType, string> = {
  CONTRIBUTION: "Contribution",
  WITHDRAWAL: "Withdrawal",
  SALE: "Sale proceeds",
  DIVIDEND: "Dividend",
  FEE: "Fee",
  EMPLOYER_CONTRIBUTION: "Employer contribution",
  INTEREST: "Interest credited",
  TRANSFER_IN: "Transferred in",
  TRANSFER_OUT: "Transferred out",
};
const SORTS: Array<{ value: NonNullable<InvestmentTransactionParams["sort"]>; label: string }> = [
  { value: "date_desc", label: "Newest first" },
  { value: "date_asc", label: "Oldest first" },
  { value: "amount_desc", label: "Largest first" },
  { value: "amount_asc", label: "Smallest first" },
];
const PAGE_SIZE = 20;

/**
 * The portfolio-wide ledger: every contribution, sale, dividend and fee across all holdings, filtered,
 * searched, sorted and paged by the server. Entries can be corrected or removed; the totals underneath
 * cover the whole filtered set, not just the page on screen.
 */
export function TransactionsPanel({ holdings, onChanged }: { holdings: PortfolioHoldingDTO[]; onChanged: (message: string) => void }) {
  const version = useFinancialVersion(["investment"]);
  const [filters, setFilters] = useState<{ type: string; investmentId: string; from: string; to: string; q: string; sort: NonNullable<InvestmentTransactionParams["sort"]> }>({
    type: "",
    investmentId: "",
    from: "",
    to: "",
    q: "",
    sort: "date_desc",
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState<PagedInvestmentTransactionsDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<InvestmentTransactionRowDTO | null>(null);
  const [draft, setDraft] = useState({ amount: "", occurredAt: "", notes: "" });
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const load = useCallback(() => {
    let active = true;
    setLoading(true);
    setError(null);
    api.investments
      .transactions({
        page,
        pageSize: PAGE_SIZE,
        type: (filters.type || undefined) as InvestmentCashflowType | undefined,
        investmentId: filters.investmentId || undefined,
        from: filters.from ? new Date(filters.from).toISOString() : undefined,
        // Include the whole of the chosen end day.
        to: filters.to ? new Date(`${filters.to}T23:59:59.999Z`).toISOString() : undefined,
        q: filters.q.trim() || undefined,
        sort: filters.sort,
      })
      .then((d) => active && setData(d))
      .catch((err) => active && setError(errText(err, "Could not load transactions.")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [filters, page]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => load(), [load, version]);

  const set = (patch: Partial<typeof filters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(1);
  };

  const startEdit = (row: InvestmentTransactionRowDTO) => {
    setEditing(row);
    setDraft({ amount: String(Number(row.amount)), occurredAt: row.occurredAt.slice(0, 10), notes: row.notes ?? "" });
    setError(null);
  };

  const save = async () => {
    if (!editing) return;
    const amount = Number(draft.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError("Enter an amount greater than zero.");
      return;
    }
    try {
      await api.investments.updateCashflow(editing.investmentId, editing.id, {
        amount,
        notes: draft.notes,
        // A schedule-generated entry keeps its date (the server refuses to move it).
        ...(editing.periodKey ? {} : { occurredAt: new Date(draft.occurredAt).toISOString() }),
      });
      setEditing(null);
      emitFinancialChange("investment");
      onChanged("Transaction corrected.");
    } catch (err) {
      setError(errText(err, "Could not save the correction."));
    }
  };

  const remove = async (row: InvestmentTransactionRowDTO) => {
    try {
      await api.investments.removeCashflow(row.investmentId, row.id);
      setConfirmId(null);
      emitFinancialChange("investment");
      onChanged("Transaction deleted.");
    } catch (err) {
      setError(errText(err, "Could not delete this transaction."));
    }
  };

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
        <div className="lg:col-span-2">
          <label htmlFor="tx-search" className="mb-1 block text-xs font-medium text-ink-soft">Search</label>
          <Input id="tx-search" placeholder="Holding or note" value={filters.q} onChange={(e) => set({ q: e.target.value })} />
        </div>
        <div>
          <label htmlFor="tx-holding" className="mb-1 block text-xs font-medium text-ink-soft">Holding</label>
          <select id="tx-holding" className={selectClass} value={filters.investmentId} onChange={(e) => set({ investmentId: e.target.value })}>
            <option value="">All holdings</option>
            {holdings.map((h) => (
              <option key={h.id} value={h.id}>{h.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tx-type" className="mb-1 block text-xs font-medium text-ink-soft">Kind</label>
          <select id="tx-type" className={selectClass} value={filters.type} onChange={(e) => set({ type: e.target.value })}>
            <option value="">All kinds</option>
            {Object.entries(TYPE_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="tx-from" className="mb-1 block text-xs font-medium text-ink-soft">From</label>
          <Input id="tx-from" type="date" value={filters.from} onChange={(e) => set({ from: e.target.value })} />
        </div>
        <div>
          <label htmlFor="tx-to" className="mb-1 block text-xs font-medium text-ink-soft">To</label>
          <Input id="tx-to" type="date" value={filters.to} onChange={(e) => set({ to: e.target.value })} />
        </div>
      </div>
      <div className="max-w-[12rem]">
        <label htmlFor="tx-sort" className="mb-1 block text-xs font-medium text-ink-soft">Sort</label>
        <select id="tx-sort" className={selectClass} value={filters.sort} onChange={(e) => set({ sort: e.target.value as typeof filters.sort })}>
          {SORTS.map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
      </div>

      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}

      {!data && loading ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : !data || data.items.length === 0 ? (
        <p className="text-sm text-ink-faint">No transactions match. Record contributions, sales or dividends from a holding’s “+ Transaction” button.</p>
      ) : (
        <>
          <ul aria-label="Transactions">
            {data.items.map((row, i) => (
              <li key={row.id} className={`py-2.5 text-sm ${i !== data.items.length - 1 ? "ledger-rule" : ""}`}>
                {editing?.id === row.id ? (
                  <div className="flex flex-wrap items-end gap-2">
                    <div>
                      <label htmlFor="tx-edit-amount" className="mb-1 block text-xs text-ink-soft">Amount (₹)</label>
                      <Input id="tx-edit-amount" type="number" step="0.01" value={draft.amount} onChange={(e) => setDraft({ ...draft, amount: e.target.value })} />
                    </div>
                    <div>
                      <label htmlFor="tx-edit-date" className="mb-1 block text-xs text-ink-soft">Date</label>
                      <Input id="tx-edit-date" type="date" disabled={!!row.periodKey} value={draft.occurredAt} onChange={(e) => setDraft({ ...draft, occurredAt: e.target.value })} />
                    </div>
                    <div className="min-w-[10rem] flex-1">
                      <label htmlFor="tx-edit-notes" className="mb-1 block text-xs text-ink-soft">Note</label>
                      <Input id="tx-edit-notes" value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
                    </div>
                    <Button size="sm" onClick={save}>Save</Button>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-ink">
                        {row.investmentName} · {TYPE_LABEL[row.type]}
                        {row.origin === "RECURRING" && <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-faint">from schedule</span>}
                      </p>
                      <p className="text-xs text-ink-faint">
                        {formatDay(row.occurredAt)}
                        {row.notes ? ` · ${row.notes}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="money text-ink">{formatINR(row.amount)}</span>
                      {confirmId === row.id ? (
                        <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm delete">
                          <span className="text-ink-soft">Delete this entry?</span>
                          <button type="button" onClick={() => remove(row)} className="font-medium text-loss hover:underline">Delete</button>
                          <button type="button" onClick={() => setConfirmId(null)} className="text-ink-faint hover:underline">Keep</button>
                        </span>
                      ) : (
                        <>
                          <button type="button" onClick={() => startEdit(row)} className="text-xs text-ink-faint hover:text-marigold-600" aria-label={`Edit ${TYPE_LABEL[row.type]} of ${formatINR(row.amount)} on ${row.investmentName}`}>Edit</button>
                          <button type="button" onClick={() => setConfirmId(row.id)} className="text-xs text-ink-faint hover:text-loss" aria-label={`Delete ${TYPE_LABEL[row.type]} of ${formatINR(row.amount)} on ${row.investmentName}`}>Remove</button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3 text-xs text-ink-soft">
            <span>
              {data.total} transaction{data.total === 1 ? "" : "s"} · put in {formatINR(data.totals.contributed)} · taken out {formatINR(data.totals.withdrawn)}
            </span>
            <span className="flex items-center gap-2">
              <Button size="sm" variant="secondary" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
              <span>Page {data.page} of {data.totalPages}</span>
              <Button size="sm" variant="secondary" disabled={page >= data.totalPages} onClick={() => setPage(page + 1)}>Next</Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
