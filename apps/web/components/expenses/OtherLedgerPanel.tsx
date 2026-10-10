"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { AccountTransferDTO, EmergencyFundEntryDTO, ReceivableDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { useFinancialVersion } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";
import type { ExpenseTypeFilter } from "@/lib/expense-filters";

export type OtherLedgerType = Exclude<ExpenseTypeFilter, "ALL" | "EXPENSE" | "OTHER_OUTFLOW">;

const EMERGENCY_LABEL: Record<EmergencyFundEntryDTO["type"], string> = {
  ALLOCATE: "Added",
  RELEASE: "Released",
  WITHDRAWAL: "Used",
  ADJUSTMENT: "Adjustment",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
};
const EMERGENCY_REDUCES = new Set<EmergencyFundEntryDTO["type"]>(["RELEASE", "WITHDRAWAL", "TRANSFER_OUT"]);

const TITLE: Record<OtherLedgerType, string> = {
  REFUNDABLE: "Refundable money (given, expected back)",
  INVESTMENT: "Investment contributions",
  EMERGENCY: "Emergency fund activity",
  TRANSFER: "Internal transfers",
};

type Rows =
  | { kind: "REFUNDABLE"; items: ReceivableDTO[] }
  | { kind: "EMERGENCY"; items: EmergencyFundEntryDTO[] }
  | { kind: "TRANSFER"; items: AccountTransferDTO[] }
  | { kind: "INVESTMENT" };

// The Type filter spans every kind of money movement, but only ordinary expenses live in the
// Expense table. For the rest this panel reads the ledger that actually owns the data — so a loan to
// a friend, an investment or a transfer is never displayed as if it were an expense.
export function OtherLedgerPanel({ type }: { type: OtherLedgerType }) {
  const version = useFinancialVersion(["receivable", "emergency", "transfer", "investment"]);
  const [rows, setRows] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setRows(null);
    setError(null);
    const load = async (): Promise<Rows> => {
      if (type === "REFUNDABLE") return { kind: "REFUNDABLE", items: await api.receivables.list("ALL") };
      if (type === "EMERGENCY") return { kind: "EMERGENCY", items: await api.emergencyFund.entries() };
      if (type === "TRANSFER") return { kind: "TRANSFER", items: await api.transfers.list() };
      return { kind: "INVESTMENT" };
    };
    load()
      .then((r) => active && setRows(r))
      .catch((err) => active && setError(err instanceof ApiError ? err.message : "Could not load this list."));
    return () => {
      active = false;
    };
  }, [type, version]);

  return (
    <Card title={TITLE[type]} eyebrow="Not an expense">
      {error ? (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      ) : !rows ? (
        <p className="text-sm text-ink-faint">Loading…</p>
      ) : rows.kind === "INVESTMENT" ? (
        <p className="text-sm text-ink-soft">
          Investment contributions are moves into assets, not spending, so they are recorded on the{" "}
          <Link href="/money/investments" className="text-marigold-600 underline">
            Investments page
          </Link>
          .
        </p>
      ) : rows.items.length === 0 ? (
        <p className="text-sm text-ink-faint">Nothing recorded yet.</p>
      ) : (
        <>
          <ul>
            {rows.kind === "REFUNDABLE" &&
              rows.items.map((r, i) => (
                <li key={r.id} className={`flex items-center justify-between py-2 text-sm ${i !== rows.items.length - 1 ? "ledger-rule" : ""}`}>
                  <div>
                    <p className="text-ink">{r.person}</p>
                    <p className="text-xs text-ink-faint">
                      {formatDay(r.givenAt)} · {r.effectiveStatus.replace("_", " ").toLowerCase()}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="money text-ink">{formatINR(r.outstandingAmount)}</p>
                    <p className="text-xs text-ink-faint">of {formatINR(r.originalAmount)} outstanding</p>
                  </div>
                </li>
              ))}
            {rows.kind === "EMERGENCY" &&
              rows.items.map((e, i) => (
                <li key={e.id} className={`flex items-center justify-between py-2 text-sm ${i !== rows.items.length - 1 ? "ledger-rule" : ""}`}>
                  <div>
                    <p className="text-ink">{EMERGENCY_LABEL[e.type]}</p>
                    <p className="text-xs text-ink-faint">
                      {formatDay(e.occurredAt)}
                      {e.notes ? ` · ${e.notes}` : ""}
                    </p>
                  </div>
                  <span className="money text-ink">
                    {EMERGENCY_REDUCES.has(e.type) ? "−" : e.type === "ADJUSTMENT" ? "" : "+"}
                    {formatINR(e.amount)}
                  </span>
                </li>
              ))}
            {rows.kind === "TRANSFER" &&
              rows.items.map((t, i) => (
                <li key={t.id} className={`flex items-center justify-between py-2 text-sm ${i !== rows.items.length - 1 ? "ledger-rule" : ""}`}>
                  <div>
                    <p className="text-ink">
                      {t.fromAccount} → {t.toAccount}
                    </p>
                    <p className="text-xs text-ink-faint">
                      {formatDay(t.transferredAt)}
                      {t.notes ? ` · ${t.notes}` : ""}
                    </p>
                  </div>
                  <span className="money text-ink">{formatINR(t.amount)}</span>
                </li>
              ))}
          </ul>
          {rows.kind === "REFUNDABLE" && (
            <p className="mt-3 text-xs text-ink-faint">
              Manage partial returns and history on the{" "}
              <Link href="/money/receivables" className="text-marigold-600 underline">
                Receivables page
              </Link>
              .
            </p>
          )}
        </>
      )}
    </Card>
  );
}
