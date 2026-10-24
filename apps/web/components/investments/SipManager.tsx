"use client";

import { useCallback, useEffect, useState } from "react";
import type { PortfolioHoldingDTO, SipChangeDTO, SipInstallmentDTO, SipInstallmentState, SipStatus } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { emitFinancialChange } from "@/lib/financial-events";
import { formatINR } from "@/lib/format";
import { formatDay } from "@/lib/dates";

const errText = (err: unknown, fallback: string) => (err instanceof ApiError ? err.message : fallback);

export const SIP_STATUS_LABEL: Record<SipStatus, string> = { NONE: "No schedule", ACTIVE: "Active", PAUSED: "Paused", CANCELLED: "Cancelled", COMPLETED: "Completed" };
const STATUS_TONE: Record<SipStatus, "success" | "warning" | "critical" | "info"> = { NONE: "info", ACTIVE: "success", PAUSED: "warning", CANCELLED: "critical", COMPLETED: "info" };

export function SipStatusBadge({ status }: { status: SipStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{SIP_STATUS_LABEL[status]}</Badge>;
}

const STATE_LABEL: Record<SipInstallmentState, string> = {
  RECORDED: "Recorded",
  PENDING: "Pending",
  SKIPPED: "Skipped",
  FAILED: "Failed",
  DUE: "Due — not recorded",
  UPCOMING: "Upcoming",
};
const STATE_TONE: Record<SipInstallmentState, "success" | "warning" | "critical" | "info"> = { RECORDED: "success", PENDING: "warning", SKIPPED: "info", FAILED: "critical", DUE: "warning", UPCOMING: "info" };

/**
 * Pause / resume / cancel for one schedule. Cancelling is final and asks first. Every action
 * reports back through onChanged so the page figures refresh without a reload.
 */
export function SipLifecycleButtons({ investmentId, status, onChanged, onError }: { investmentId: string; status: SipStatus; onChanged: (message: string) => void; onError: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const run = async (action: "pause" | "resume" | "cancel") => {
    setBusy(true);
    try {
      if (action === "pause") await api.investments.pauseSip(investmentId);
      else if (action === "resume") await api.investments.resumeSip(investmentId);
      else await api.investments.cancelSip(investmentId);
      setConfirmCancel(false);
      emitFinancialChange("investment");
      onChanged(action === "pause" ? "Schedule paused. Nothing will be recorded until you resume it." : action === "resume" ? "Schedule resumed. Instalments missed while paused stay marked as skipped." : "Schedule cancelled. Everything already recorded is kept.");
    } catch (err) {
      onError(errText(err, "Could not change the schedule."));
    } finally {
      setBusy(false);
    }
  };

  if (status === "NONE" || status === "CANCELLED" || status === "COMPLETED") return null;
  if (confirmCancel) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs" role="group" aria-label="Confirm cancel schedule">
        <span className="text-ink-soft">Cancel this schedule for good? Contributions already recorded are kept.</span>
        <button type="button" disabled={busy} onClick={() => run("cancel")} className="font-medium text-loss hover:underline">
          Cancel schedule
        </button>
        <button type="button" onClick={() => setConfirmCancel(false)} className="text-ink-faint hover:underline">
          Keep it
        </button>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-2">
      {status === "ACTIVE" ? (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run("pause")}>
          Pause
        </Button>
      ) : (
        <Button size="sm" variant="secondary" disabled={busy} onClick={() => run("resume")}>
          Resume
        </Button>
      )}
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmCancel(true)}>
        Cancel schedule
      </Button>
    </span>
  );
}

/** What each scheduled date became. Only a RECORDED instalment counts as invested. */
export function SipInstallments({ investmentId, version, onChanged }: { investmentId: string; version?: number; onChanged: (message: string) => void }) {
  const [rows, setRows] = useState<SipInstallmentDTO[] | null>(null);
  const [changes, setChanges] = useState<SipChangeDTO[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, hist] = await Promise.all([api.investments.sipInstallments(investmentId), api.investments.sipChanges(investmentId)]);
      setRows(list);
      setChanges(hist);
    } catch (err) {
      setRows([]);
      setError(errText(err, "Could not load the instalments."));
    }
  }, [investmentId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const record = async (periodKey: string, status: "CONFIRMED" | "SKIPPED" | "FAILED") => {
    setBusyKey(periodKey);
    setError(null);
    try {
      await api.investments.recordInstallment(investmentId, { periodKey, status });
      emitFinancialChange("investment");
      onChanged(status === "CONFIRMED" ? "Instalment recorded as paid." : status === "SKIPPED" ? "Instalment marked as skipped — it is not counted as invested." : "Instalment marked as failed — it is not counted as invested.");
      await load();
    } catch (err) {
      setError(errText(err, "Could not record this instalment."));
    } finally {
      setBusyKey(null);
    }
  };

  if (!rows) return <p className="text-sm text-ink-faint">Loading instalments…</p>;
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-sm text-ink-faint">No instalments have fallen due yet.</p>
      ) : (
        <ul aria-label="Instalments">
          {rows.map((r, i) => (
            <li key={r.periodKey} className={`flex flex-wrap items-center justify-between gap-2 py-2 text-sm ${i !== rows.length - 1 ? "ledger-rule" : ""}`}>
              <div>
                <p className="text-ink">{formatDay(r.scheduledFor)}</p>
                {r.notes && <p className="text-xs text-ink-faint">{r.notes}</p>}
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="money text-ink">{r.amount ? formatINR(r.amount) : "—"}</span>
                <Badge tone={STATE_TONE[r.state]}>{STATE_LABEL[r.state]}</Badge>
                {(r.state === "DUE" || r.state === "PENDING" || r.state === "SKIPPED" || r.state === "FAILED") && (
                  <span className="flex gap-2 text-xs">
                    <button type="button" disabled={busyKey === r.periodKey} onClick={() => record(r.periodKey, "CONFIRMED")} className="font-medium text-marigold-600 hover:underline" aria-label={`Mark ${formatDay(r.scheduledFor)} instalment as paid`}>
                      Mark paid
                    </button>
                    {r.state === "DUE" && (
                      <>
                        <button type="button" disabled={busyKey === r.periodKey} onClick={() => record(r.periodKey, "SKIPPED")} className="text-ink-faint hover:text-ink-soft" aria-label={`Mark ${formatDay(r.scheduledFor)} instalment as skipped`}>
                          Skipped
                        </button>
                        <button type="button" disabled={busyKey === r.periodKey} onClick={() => record(r.periodKey, "FAILED")} className="text-ink-faint hover:text-loss" aria-label={`Mark ${formatDay(r.scheduledFor)} instalment as failed`}>
                          Failed
                        </button>
                      </>
                    )}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {changes.length > 0 && (
        <div>
          <p className="stat-label mb-1">Schedule history</p>
          <ul className="text-xs text-ink-soft">
            {changes.map((c) => (
              <li key={c.id}>
                {formatDay(c.effectiveFrom)} · {c.reason.replace(/_/g, " ").toLowerCase()} · {formatINR(c.amountPerPeriod)} per {c.frequency.toLowerCase().replace("biweekly", "2 weeks")}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Every recurring schedule at a glance, with the controls that matter. */
export function SipManager({ holdings, onChanged }: { holdings: PortfolioHoldingDTO[]; onChanged: (message: string) => void }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sips = holdings.filter((h) => h.sipStatus !== "NONE");
  const order: Record<SipStatus, number> = { ACTIVE: 0, PAUSED: 1, COMPLETED: 2, CANCELLED: 3, NONE: 4 };
  sips.sort((a, b) => order[a.sipStatus] - order[b.sipStatus]);

  if (sips.length === 0) {
    return <p className="text-sm text-ink-faint">No recurring schedules yet. Open a holding and use “Set up a schedule” on its Recurring tab.</p>;
  }
  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="text-sm text-loss">
          {error}
        </p>
      )}
      <ul>
        {sips.map((h, i) => (
          <li key={h.id} className={`py-3 text-sm ${i !== sips.length - 1 ? "ledger-rule" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 text-ink">
                  {h.name}
                  <SipStatusBadge status={h.sipStatus} />
                </p>
                <p className="text-xs text-ink-faint">
                  {h.plannedMonthly ? `Plans ${formatINR(h.plannedMonthly)} a month · ` : ""}added this month {formatINR(h.contributedThisMonth)} · invested {formatINR(h.invested)} · worth {formatINR(h.currentValue)}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <SipLifecycleButtons investmentId={h.id} status={h.sipStatus} onChanged={onChanged} onError={setError} />
                <button type="button" aria-expanded={openId === h.id} onClick={() => setOpenId(openId === h.id ? null : h.id)} className="text-xs font-medium text-marigold-600 hover:underline">
                  {openId === h.id ? "Hide instalments" : "Instalments"}
                </button>
              </div>
            </div>
            {openId === h.id && (
              <div className="mt-3 rounded-md border border-line bg-surface p-3">
                <SipInstallments investmentId={h.id} onChanged={onChanged} />
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
