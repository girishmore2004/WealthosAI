"use client";

import { useEffect, useState } from "react";
import type { DataHealthReportDTO } from "@wealthos/types";
import { api } from "@/lib/api-client";
import { Badge } from "@/components/ui/Badge";

// Reconciliation status from the shared financial-core facts layer. The same issues are
// what the AI Coach reads, so what the user sees here is what the Coach will mention.
// Flags only — nothing here deletes or edits a record.
export function DataHealthCard() {
  const [report, setReport] = useState<DataHealthReportDTO | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    api.financialCore
      .dataHealth()
      .then(setReport)
      .catch(() => setFailed(true));
  }, []);

  if (failed) {
    return (
      <div className="panel p-5 sm:p-6">
        <p className="stat-label mb-2">Data health</p>
        <p className="text-sm text-ink-soft">Could not check your data right now.</p>
      </div>
    );
  }
  if (!report) return null;

  return (
    <div className="panel p-5 sm:p-6">
      <div className="mb-3 flex items-center justify-between">
        <p className="stat-label">Data health</p>
        <Badge tone={report.status === "HEALTHY" ? "info" : "warning"}>
          {report.status === "HEALTHY" ? "Reconciled" : "Needs review"}
        </Badge>
      </div>
      <ul className="space-y-1.5">
        {report.checks.map((c) => (
          <li key={c.label} className="flex items-center gap-2 text-sm">
            <span aria-hidden className={c.ok ? "text-gain" : "text-loss"}>
              {c.ok ? "✓" : "⚠"}
            </span>
            <span className={c.ok ? "text-ink-soft" : "text-ink"}>{c.label}</span>
          </li>
        ))}
      </ul>
      {report.issues.length > 0 && (
        <ul className="mt-4 space-y-2">
          {report.issues.map((issue) => (
            <li key={issue.code} className="rounded-md border-l-2 border-marigold-500 bg-surface-muted/60 py-2 pl-3 pr-3">
              <p className="text-xs text-ink-soft">{issue.message}</p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
