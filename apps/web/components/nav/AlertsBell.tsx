"use client";

import { useEffect, useRef, useState } from "react";
import type { AlertDTO } from "@wealthos/types";
import { api } from "@/lib/api-client";

const SEVERITY_DOT: Record<AlertDTO["severity"], string> = {
  INFO: "bg-ink-faint",
  WARNING: "bg-marigold-500",
  CRITICAL: "bg-loss",
};

export function AlertsBell() {
  const [alerts, setAlerts] = useState<AlertDTO[]>([]);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () => {
    api.alerts.refresh().then(setAlerts).catch(() => api.alerts.list().then(setAlerts).catch(() => {}));
  };

  useEffect(() => {
    load();
    const onClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  const unreadCount = alerts.filter((a) => !a.isRead).length;

  const onMarkRead = async (id: string) => {
    setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, isRead: true } : a)));
    await api.alerts.markRead(id);
  };

  const onDismiss = async (id: string) => {
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    await api.alerts.dismiss(id);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-sm p-1.5 text-ink-soft hover:text-ink"
        aria-label="Alerts"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.73 21a2 2 0 01-3.46 0" />
        </svg>
        {unreadCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-marigold-500 px-1 text-[10px] font-medium text-white">
            {unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-10 mt-2 w-[calc(100vw-2rem)] max-w-80 rounded-sm border border-line bg-surface shadow-lg">
          <div className="ledger-rule flex items-center justify-between px-4 py-2">
            <p className="text-xs uppercase tracking-wide text-ink-faint">Alerts</p>
            <button onClick={load} className="text-xs text-ink-faint hover:text-ink">
              Refresh
            </button>
          </div>
          <div className="max-h-80 overflow-y-auto">
            {alerts.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-ink-faint">No alerts right now.</p>
            ) : (
              alerts.map((alert) => (
                <div key={alert.id} className="ledger-rule flex gap-2 px-4 py-3 last:border-b-0">
                  <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[alert.severity]}`} />
                  <div className="flex-1">
                    <p className={`text-sm ${alert.isRead ? "text-ink-faint" : "text-ink"}`}>{alert.title}</p>
                    <p className="mt-0.5 text-xs text-ink-faint">{alert.message}</p>
                    <div className="mt-1 flex gap-3">
                      {!alert.isRead && (
                        <button onClick={() => onMarkRead(alert.id)} className="text-[11px] text-marigold-600 hover:underline">
                          Mark read
                        </button>
                      )}
                      <button onClick={() => onDismiss(alert.id)} className="text-[11px] text-ink-faint hover:text-loss">
                        Dismiss
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
