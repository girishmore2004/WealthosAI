"use client";

import { useEffect, useState, FormEvent } from "react";
import type { CategoryDTO, IngestionBatchDTO, IngestionBatchSummaryDTO, IngestionReviewItemDTO, PaymentMethod } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatINR } from "@/lib/format";

const PAYMENT_METHODS: PaymentMethod[] = ["UPI", "CARD", "CASH", "BANK_TRANSFER", "WALLET", "OTHER"];

export default function CopilotIngestionPage() {
  const [sourceLabel, setSourceLabel] = useState("");
  const [rawText, setRawText] = useState("");
  const [defaultPaymentMethod, setDefaultPaymentMethod] = useState<PaymentMethod>("CARD");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [history, setHistory] = useState<IngestionBatchSummaryDTO[]>([]);
  const [activeBatch, setActiveBatch] = useState<IngestionBatchDTO | null>(null);

  useEffect(() => {
    api.expenses.categories().then(setCategories).catch(() => {});
    api.copilotIngestion.listBatches().then(setHistory).catch(() => {});
  }, []);

  const loadBatch = (id: string) => {
    api.copilotIngestion.getBatch(id).then(setActiveBatch).catch(() => {});
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!rawText.trim() || !sourceLabel.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const batch = await api.copilotIngestion.createBatch(sourceLabel, rawText, defaultPaymentMethod);
      setActiveBatch(batch);
      setRawText("");
      api.copilotIngestion.listBatches().then(setHistory).catch(() => {});
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Couldn't process this statement right now.");
    } finally {
      setCreating(false);
    }
  };

  const onItemResolved = (updated: IngestionReviewItemDTO) => {
    setActiveBatch((prev) => (prev ? { ...prev, items: prev.items.map((i) => (i.id === updated.id ? updated : i)) } : prev));
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Copilot Ingestion</h1>
        <p className="text-sm text-ink-soft">
          Paste a bank or card statement (or its OCR&apos;d text). Nothing is added to your expenses until you
          review and approve each line — this only ever stages suggestions.
        </p>
      </div>

      <Card title="Import a statement">
        <form onSubmit={onSubmit} className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input placeholder="Label, e.g. HDFC Feb statement" value={sourceLabel} onChange={(e) => setSourceLabel(e.target.value)} />
            <select
              value={defaultPaymentMethod}
              onChange={(e) => setDefaultPaymentMethod(e.target.value as PaymentMethod)}
              className="rounded-sm border border-line bg-surface px-3 py-2 text-sm"
            >
              {PAYMENT_METHODS.map((m) => (
                <option key={m} value={m}>
                  Default payment method: {m.replace("_", " ").toLowerCase()}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder={"15/01/2026, POS AMAZON.IN 4829102, 1249.00 Dr\n16/01/2026, UPI-SWIGGY BANGALORE, 350.50 Dr\n..."}
            rows={8}
            className="w-full rounded-sm border border-line bg-surface p-3 font-mono text-xs"
          />
          <Button type="submit" disabled={creating || !rawText.trim() || !sourceLabel.trim()}>
            {creating ? "Processing…" : "Process statement"}
          </Button>
        </form>
      </Card>

      {error && (
        <Card className="border-loss">
          <p className="text-sm text-loss">{error}</p>
        </Card>
      )}

      {history.length > 0 && (
        <Card eyebrow="Past imports" title="History">
          <div className="flex flex-wrap gap-2">
            {history.map((b) => (
              <button
                key={b.id}
                onClick={() => loadBatch(b.id)}
                className="rounded-sm border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-marigold-500 hover:text-marigold-600"
              >
                {b.sourceLabel} · {b._count.items} lines
              </button>
            ))}
          </div>
        </Card>
      )}

      {activeBatch && (
        <Card
          eyebrow={`${activeBatch.parsedCount} parsed, ${activeBatch.unparsedCount} couldn't be parsed`}
          title={activeBatch.sourceLabel}
        >
          <div className="space-y-3">
            {activeBatch.items.map((item) => (
              <ReviewItemRow key={item.id} item={item} categories={categories} onResolved={onItemResolved} />
            ))}
            {activeBatch.items.length === 0 && <p className="text-sm text-ink-faint">No transactions were parsed from this import.</p>}
          </div>
        </Card>
      )}
    </div>
  );
}

function ReviewItemRow({
  item,
  categories,
  onResolved,
}: {
  item: IngestionReviewItemDTO;
  categories: CategoryDTO[];
  onResolved: (item: IngestionReviewItemDTO) => void;
}) {
  const [categoryId, setCategoryId] = useState(item.suggestedCategoryId ?? "");
  const [duplicateResolution, setDuplicateResolution] = useState<"kept_both" | "skipped_duplicate" | "merged">("kept_both");
  const [busy, setBusy] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);

  const confidence = Number(item.overallConfidence);
  const tier = confidence >= 0.7 ? "text-gain" : confidence >= 0.4 ? "text-marigold-600" : "text-loss";

  const approve = async () => {
    setBusy(true);
    setLocalError(null);
    try {
      const updated = await api.copilotIngestion.approve(item.id, {
        categoryId: categoryId || undefined,
        duplicateResolution: item.isDuplicateCandidate ? duplicateResolution : undefined,
      });
      onResolved(updated);
    } catch (err) {
      setLocalError(err instanceof ApiError ? err.message : "Couldn't approve this item.");
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    setBusy(true);
    try {
      const updated = await api.copilotIngestion.reject(item.id);
      onResolved(updated);
    } finally {
      setBusy(false);
    }
  };

  if (item.status !== "PENDING") {
    return (
      <div className="flex items-center justify-between border-b border-line pb-2 text-sm last:border-b-0">
        <span className="text-ink-soft">{item.merchantNormalized}</span>
        <span className={`text-xs uppercase tracking-wide ${item.status === "APPROVED" ? "text-gain" : "text-ink-faint"}`}>{item.status.toLowerCase()}</span>
      </div>
    );
  }

  return (
    <div className="rounded-sm border border-line p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-ink">{item.merchantNormalized}</p>
          <p className="text-xs text-ink-faint">
            {new Date(item.parsedDate).toLocaleDateString()} · {formatINR(item.parsedAmount)}
          </p>
        </div>
        <span className={`font-mono text-xs ${tier}`}>{Math.round(confidence * 100)}% confidence</span>
      </div>

      <p className="mt-2 text-xs text-ink-soft">{item.rationale}</p>

      <div className="mt-2 flex flex-wrap gap-1">
        {item.isDuplicateCandidate && (
          <span className="rounded-sm bg-marigold-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-marigold-600">Possible duplicate</span>
        )}
        {item.isAnomalyCandidate && (
          <span className="rounded-sm bg-marigold-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-marigold-600">Unusual amount</span>
        )}
        {item.isRecurringCandidate && (
          <span className="rounded-sm bg-paper px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">Matches a subscription</span>
        )}
        {item.missingFields.map((f) => (
          <span key={f} className="rounded-sm bg-paper px-2 py-0.5 text-[10px] text-ink-faint">
            {f}
          </span>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select
          value={categoryId}
          onChange={(e) => setCategoryId(e.target.value)}
          className="rounded-sm border border-line bg-surface px-2 py-1.5 text-xs"
        >
          <option value="">No category selected</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>

        {item.isDuplicateCandidate && (
          <select
            value={duplicateResolution}
            onChange={(e) => setDuplicateResolution(e.target.value as typeof duplicateResolution)}
            className="rounded-sm border border-line bg-surface px-2 py-1.5 text-xs"
          >
            <option value="kept_both">Keep as a new, separate expense</option>
            <option value="merged">Merge into the existing expense</option>
            <option value="skipped_duplicate">Skip — it&apos;s a duplicate</option>
          </select>
        )}

        <Button onClick={approve} disabled={busy || (!categoryId && duplicateResolution !== "skipped_duplicate")} className="px-3 py-1.5 text-xs">
          Approve
        </Button>
        <Button variant="secondary" onClick={reject} disabled={busy} className="px-3 py-1.5 text-xs">
          Reject
        </Button>
      </div>
      {localError && <p className="mt-2 text-xs text-loss">{localError}</p>}
    </div>
  );
}
