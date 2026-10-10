"use client";

import { useEffect, useState } from "react";
import type { ReceivableDTO, ReceivableStatus, ReceivableSummaryDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { BasisTag } from "@/components/ui/BasisTag";
import { ReceivableFormDialog, RepaymentDialog } from "@/components/receivables/ReceivableDialogs";
import { emitFinancialChange, useFinancialVersion } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

type Scope = "ACTIVE" | "CLOSED" | "CANCELLED" | "ALL";
const SCOPES: Array<{ value: Scope; label: string }> = [
  { value: "ACTIVE", label: "Outstanding" },
  { value: "CLOSED", label: "Fully returned" },
  { value: "CANCELLED", label: "Cancelled" },
  { value: "ALL", label: "All" },
];

const STATUS_LABEL: Record<ReceivableStatus, string> = {
  OUTSTANDING: "Outstanding",
  PARTIALLY_RETURNED: "Partly returned",
  FULLY_RETURNED: "Returned",
  OVERDUE: "Overdue",
  CANCELLED: "Cancelled",
};
const STATUS_TONE: Record<ReceivableStatus, "info" | "warning" | "critical" | "success"> = {
  OUTSTANDING: "info",
  PARTIALLY_RETURNED: "warning",
  FULLY_RETURNED: "success",
  OVERDUE: "critical",
  CANCELLED: "info",
};

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

function dueText(r: ReceivableDTO): string | null {
  if (r.daysUntilDue === null) return null;
  if (r.daysUntilDue < 0) return `${-r.daysUntilDue} day${r.daysUntilDue === -1 ? "" : "s"} overdue`;
  if (r.daysUntilDue === 0) return "due today";
  return `due in ${r.daysUntilDue} day${r.daysUntilDue === 1 ? "" : "s"}`;
}

function SummaryStat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="panel p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="stat-label">{label}</p>
        <BasisTag basis="ACTUAL" />
      </div>
      <p className="money mt-2 text-xl font-semibold text-ink">{value}</p>
      {sub && <p className="mt-1 text-xs text-ink-faint">{sub}</p>}
    </div>
  );
}

export default function ReceivablesPage() {
  const version = useFinancialVersion(["receivable"]);
  const [scope, setScope] = useState<Scope>("ACTIVE");
  const [items, setItems] = useState<ReceivableDTO[]>([]);
  const [summary, setSummary] = useState<ReceivableSummaryDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ReceivableDTO | null>(null);
  const [repaying, setRepaying] = useState<ReceivableDTO | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ReceivableDTO | null>(null);
  const [confirm, setConfirm] = useState<{ id: string; action: "remove" | "cancel" | "repayment"; repaymentId?: string } | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    Promise.all([api.receivables.list(scope), api.receivables.summary()])
      .then(([list, s]) => {
        if (!active) return;
        setItems(list);
        setSummary(s);
      })
      .catch((err) => active && setError(errText(err, "Could not load receivables.")))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [scope, version]);

  // The history of the expanded receivable (every repayment, newest first).
  useEffect(() => {
    if (!expandedId) {
      setDetail(null);
      return;
    }
    let active = true;
    api.receivables
      .get(expandedId)
      .then((d) => active && setDetail(d))
      .catch((err) => active && setActionError(errText(err, "Could not load the history.")));
    return () => {
      active = false;
    };
  }, [expandedId, version]);

  const done = (message: string) => {
    setActionError(null);
    setNotice(message);
  };

  const runConfirmed = async () => {
    if (!confirm) return;
    setActionError(null);
    try {
      if (confirm.action === "remove") await api.receivables.remove(confirm.id);
      else if (confirm.action === "cancel") await api.receivables.cancel(confirm.id);
      else if (confirm.repaymentId) await api.receivables.removeRepayment(confirm.id, confirm.repaymentId);
      setNotice(confirm.action === "remove" ? "Receivable deleted." : confirm.action === "cancel" ? "Receivable cancelled — it no longer counts anywhere." : "Repayment removed.");
      setConfirm(null);
      emitFinancialChange("receivable");
    } catch (err) {
      setActionError(errText(err, "Could not complete that action."));
    }
  };

  const confirmText =
    confirm?.action === "remove"
      ? "Permanently delete this receivable?"
      : confirm?.action === "cancel"
        ? "Cancel this entry? It will stop counting in your totals (the record is kept)."
        : "Remove this repayment? The money will count as outstanding again.";

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">Receivables</h1>
          <p className="text-sm text-ink-soft">Money you gave that is expected back. It is never counted as an expense.</p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setFormOpen(true);
          }}
          className="fixed bottom-5 right-5 z-40 rounded-full px-5 py-3 shadow-popover sm:static sm:rounded-md sm:px-4 sm:py-2.5 sm:shadow-card"
        >
          + Money given
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <SummaryStat label="Total outstanding" value={summary ? formatINR(summary.totalOutstanding) : "—"} sub={summary ? `${summary.activeCount} open` : undefined} />
        <SummaryStat label="Due soon" value={summary ? formatINR(summary.dueSoon.amount) : "—"} sub={summary ? `${summary.dueSoon.count} within ${summary.dueSoon.withinDays} days` : undefined} />
        <SummaryStat label="Overdue" value={summary ? formatINR(summary.overdue.amount) : "—"} sub={summary ? `${summary.overdue.count} past due` : undefined} />
        <SummaryStat label="Returned this month" value={summary ? formatINR(summary.returnedThisMonth) : "—"} />
        <SummaryStat label="Largest" value={summary?.largest ? formatINR(summary.largest.outstandingAmount) : "—"} sub={summary?.largest?.person} />
      </div>

      {notice && (
        <p role="status" className="rounded-md border border-line bg-surface-muted px-3 py-2 text-sm text-ink">
          {notice}
        </p>
      )}

      <Card title="Money given">
        <div role="tablist" aria-label="Show" className="mb-4 flex gap-1 overflow-x-auto border-b border-line pb-px">
          {SCOPES.map((s) => (
            <button
              key={s.value}
              role="tab"
              type="button"
              aria-selected={scope === s.value}
              onClick={() => setScope(s.value)}
              className={`shrink-0 whitespace-nowrap border-b-2 px-3 py-2 text-sm ${scope === s.value ? "border-marigold-500 font-medium text-ink" : "border-transparent text-ink-faint hover:text-ink-soft"}`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {actionError && (
          <p role="alert" className="mb-3 text-sm text-loss">
            {actionError}
          </p>
        )}

        {error ? (
          <p role="alert" className="text-sm text-loss">
            {error}
          </p>
        ) : loading ? (
          <p className="text-sm text-ink-faint">Loading…</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-faint">{scope === "ACTIVE" ? "Nothing is outstanding. Record money you lend with “+ Money given”." : "Nothing here yet."}</p>
        ) : (
          <ul>
            {items.map((r, i) => {
              const open = r.status === "OUTSTANDING" || r.status === "PARTIALLY_RETURNED";
              const noHistory = Number(r.returnedAmount) === 0;
              const due = dueText(r);
              return (
                <li key={r.id} className={`py-3 text-sm ${i !== items.length - 1 ? "ledger-rule" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-ink">
                        {r.person}
                        <Badge tone={STATUS_TONE[r.effectiveStatus]}>{STATUS_LABEL[r.effectiveStatus]}</Badge>
                      </p>
                      <p className="text-xs text-ink-faint">
                        Given {formatDay(r.givenAt)}
                        {r.purpose ? ` · ${r.purpose}` : ""}
                        {r.expectedReturnAt ? ` · expected ${formatDay(r.expectedReturnAt)}` : ""}
                        {open && due ? ` (${due})` : ""}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="money text-ink">{formatINR(r.outstandingAmount)}</p>
                      <p className="text-xs text-ink-faint">
                        of {formatINR(r.originalAmount)}
                        {!noHistory ? ` · ${formatINR(r.returnedAmount)} returned` : ""}
                      </p>
                    </div>
                  </div>

                  {confirm?.id === r.id && confirm.action !== "repayment" ? (
                    <p className="mt-2 flex flex-wrap items-center gap-3 text-xs" role="group" aria-label="Confirm">
                      <span className="text-ink-soft">{confirmText}</span>
                      <button type="button" onClick={runConfirmed} className="font-medium text-loss hover:underline">
                        Yes, {confirm.action === "remove" ? "delete" : "cancel it"}
                      </button>
                      <button type="button" onClick={() => setConfirm(null)} className="text-ink-faint hover:underline">
                        Keep
                      </button>
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-xs">
                      {open && (
                        <button type="button" onClick={() => setRepaying(r)} className="font-medium text-marigold-600 hover:underline">
                          Record return
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setExpandedId(expandedId === r.id ? null : r.id)}
                        aria-expanded={expandedId === r.id}
                        className="text-ink-faint hover:text-ink"
                      >
                        {expandedId === r.id ? "Hide history" : "History"}
                      </button>
                      {r.status !== "CANCELLED" && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(r);
                            setFormOpen(true);
                          }}
                          className="text-ink-faint hover:text-marigold-600"
                        >
                          Edit
                        </button>
                      )}
                      {noHistory && r.status !== "CANCELLED" && (
                        <button type="button" onClick={() => setConfirm({ id: r.id, action: "cancel" })} className="text-ink-faint hover:text-loss">
                          Cancel entry
                        </button>
                      )}
                      {noHistory && (
                        <button type="button" onClick={() => setConfirm({ id: r.id, action: "remove" })} className="text-ink-faint hover:text-loss">
                          Delete
                        </button>
                      )}
                    </div>
                  )}

                  {expandedId === r.id && (
                    <div className="mt-3 rounded-md border border-line bg-surface-muted p-3">
                      {!detail || detail.id !== r.id ? (
                        <p className="text-xs text-ink-faint">Loading…</p>
                      ) : !detail.repayments || detail.repayments.length === 0 ? (
                        <p className="text-xs text-ink-faint">No returns recorded yet.</p>
                      ) : (
                        <ul>
                          {detail.repayments.map((p) => (
                            <li key={p.id} className="flex items-center justify-between py-1 text-xs">
                              <span className="text-ink-soft">
                                {formatDay(p.returnedAt)} · {p.paymentMethod.toLowerCase().replace("_", " ")}
                                {p.notes ? ` · ${p.notes}` : ""}
                              </span>
                              <span className="flex items-center gap-3">
                                <span className="money text-gain">+{formatINR(p.amount)}</span>
                                {confirm?.repaymentId === p.id ? (
                                  <span className="flex items-center gap-2" role="group" aria-label="Confirm">
                                    <span className="text-ink-soft">{confirmText}</span>
                                    <button type="button" onClick={runConfirmed} className="font-medium text-loss hover:underline">
                                      Remove
                                    </button>
                                    <button type="button" onClick={() => setConfirm(null)} className="text-ink-faint hover:underline">
                                      Keep
                                    </button>
                                  </span>
                                ) : (
                                  <button type="button" onClick={() => setConfirm({ id: r.id, action: "repayment", repaymentId: p.id })} className="text-ink-faint hover:text-loss">
                                    Remove
                                  </button>
                                )}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ReceivableFormDialog open={formOpen} onClose={() => setFormOpen(false)} editing={editing} onSaved={done} />
      <RepaymentDialog receivable={repaying} onClose={() => setRepaying(null)} onSaved={done} />
    </div>
  );
}
