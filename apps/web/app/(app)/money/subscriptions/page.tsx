"use client";

import { useEffect, useState } from "react";
import type { DetectedSubscriptionDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { formatINR } from "@/lib/format";

const CONFIDENCE_STYLES: Record<DetectedSubscriptionDTO["confidence"], string> = {
  HIGH: "bg-gain/10 text-gain",
  MEDIUM: "bg-marigold-500/10 text-marigold-600",
  LOW: "bg-ink-faint/10 text-ink-faint",
};

export default function SubscriptionsPage() {
  const [subs, setSubs] = useState<DetectedSubscriptionDTO[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.expenses
      .subscriptions()
      .then(setSubs)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load subscriptions."));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Subscriptions</h1>
        <p className="text-sm text-ink-soft">
          Recurring charges detected from your expense history — the same merchant billing you 2+ times in the last
          three months. This is a detector, not a separate list you maintain — there is nothing to add or edit here
          directly; go fix the underlying charge under{" "}
          <a href="/money/expenses" className="text-marigold-600 hover:underline">
            Expenses
          </a>{" "}
          if something looks wrong.
        </p>
      </div>

      <Card>
        {error ? (
          <p className="text-sm text-loss">{error}</p>
        ) : !subs ? (
          <p className="text-sm text-ink-faint">Scanning recent expenses…</p>
        ) : subs.length === 0 ? (
          <p className="text-sm text-ink-faint">No recurring charges detected yet — log a few months of expenses first.</p>
        ) : (
          <ul>
            {subs
              .sort((a, b) => b.averageAmount - a.averageAmount)
              .map((sub, i) => (
                <li
                  key={sub.merchant}
                  className={`flex items-center justify-between py-2.5 text-sm ${i !== subs.length - 1 ? "ledger-rule" : ""}`}
                >
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-ink capitalize">{sub.merchant}</p>
                      <span className={`rounded-sm px-1.5 py-0.5 text-[10px] uppercase tracking-wide ${CONFIDENCE_STYLES[sub.confidence]}`}>
                        {sub.confidence.toLowerCase()} confidence
                      </span>
                    </div>
                    <p className="text-xs text-ink-faint">
                      Seen {sub.occurrences} times in the last 3 months · last on{" "}
                      {new Date(sub.lastSeenAt).toLocaleDateString("en-IN")} · based on {sub.sourceExpenseIds.length} logged
                      expense{sub.sourceExpenseIds.length === 1 ? "" : "s"}
                    </p>
                  </div>
                  <span className="money text-ink">{formatINR(sub.averageAmount)}/mo avg</span>
                </li>
              ))}
          </ul>
        )}
      </Card>
      <p className="text-[11px] text-ink-faint">
        Subscriptions is intentionally a detector, not its own trackable record — it always reflects your actual
        logged Expenses rather than a second, editable copy of the truth that could drift out of sync. Detection is a
        simple heuristic (same merchant name, 2+ occurrences in 3 months): 2 occurrences shows as medium confidence,
        3+ as high confidence. It can miss renamed merchants or flag genuinely one-off repeat purchases — review
        before assuming any charge is unwanted.
      </p>
    </div>
  );
}
