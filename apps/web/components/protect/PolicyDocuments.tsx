"use client";

import { useCallback, useEffect, useState } from "react";
import type { DocumentDTO, DocumentDiscrepancyDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { formatINR } from "@/lib/format";

const DOCUMENT_TYPES: Array<{ value: string; label: string }> = [
  { value: "POLICY_PDF", label: "Policy document" },
  { value: "PREMIUM_RECEIPT", label: "Premium receipt" },
  { value: "NOMINEE_PROOF", label: "Nominee proof" },
];

const FIELD_LABEL: Record<string, string> = { premiumAmount: "Premium", coverageAmount: "Coverage", renewalDate: "Renewal date" };

function show(field: string, value: string): string {
  return field === "renewalDate" ? new Date(value).toLocaleDateString("en-IN") : formatINR(value);
}

// Documents for ONE policy: upload (linked to the policy server-side), the linked list, and any
// conflicts between a document and the stored policy. Reviewing a conflict never edits the
// policy — to adopt the document's value the user edits the policy itself, then re-checks.
export function PolicyDocuments({ policyId, onPremiumRecorded }: { policyId: string; onPremiumRecorded?: () => void }) {
  const [docs, setDocs] = useState<DocumentDTO[]>([]);
  const [conflicts, setConflicts] = useState<DocumentDiscrepancyDTO[]>([]);
  const [documentType, setDocumentType] = useState("POLICY_PDF");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    Promise.all([api.documents.byEntity("POLICY", policyId), api.documents.discrepancies()])
      .then(([list, open]) => {
        setDocs(list);
        setConflicts(open.filter((d) => d.entityType === "POLICY" && d.entityId === policyId));
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load documents."));
  }, [policyId]);

  useEffect(load, [load]);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.documents.upload(file, { category: "INSURANCE_POLICY", entityType: "POLICY", entityId: policyId, documentType });
      setMessage("Uploaded. Text is being extracted and checked against this policy.");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Upload failed.");
    } finally {
      setBusy(false);
    }
  };

  const resolve = async (id: string, resolution: "KEEP_DATABASE" | "DISMISS") => {
    try {
      await api.documents.resolveDiscrepancy(id, resolution);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update this item.");
    }
  };

  const recordPremium = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api.insurance.recordPremium(policyId);
      setMessage(r.created ? `Premium for ${r.period} recorded.` : `Premium for ${r.period} was already recorded — nothing added.`);
      onPremiumRecorded?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not record the premium.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 rounded-md bg-surface-muted/60 p-3">
      {conflicts.length > 0 && (
        <ul className="mb-3 space-y-2">
          {conflicts.map((c) => (
            <li key={c.id} className="border-l-2 border-marigold-500 pl-3 text-xs text-ink-soft">
              <p>
                <span className="text-ink">{FIELD_LABEL[c.field] ?? c.field}</span>: your document says {show(c.field, c.documentValue)}, your records say{" "}
                {show(c.field, c.databaseValue)}. Your records were not changed.
              </p>
              <div className="mt-1 flex gap-3">
                <button onClick={() => resolve(c.id, "KEEP_DATABASE")} className="text-ink-faint hover:text-marigold-600">
                  My records are right
                </button>
                <button onClick={() => resolve(c.id, "DISMISS")} className="text-ink-faint hover:text-marigold-600">
                  Dismiss
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {docs.length === 0 ? (
        <p className="text-xs text-ink-faint">No documents linked to this policy yet.</p>
      ) : (
        <ul className="mb-2 space-y-1">
          {docs.map((d) => (
            <li key={d.id} className="text-xs text-ink-soft">
              {d.fileName}
              {d.documentType ? ` · ${d.documentType.replace(/_/g, " ").toLowerCase()}` : ""}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Document type"
          value={documentType}
          onChange={(e) => setDocumentType(e.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1 text-xs"
        >
          {DOCUMENT_TYPES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
        <label className="cursor-pointer text-xs text-ink-faint hover:text-marigold-600">
          {busy ? "Working…" : "Upload document"}
          <input
            type="file"
            accept="application/pdf,image/jpeg,image/png,image/webp"
            className="sr-only"
            disabled={busy}
            onChange={(e) => onFile(e.target.files?.[0])}
          />
        </label>
        <Button type="button" onClick={recordPremium} disabled={busy}>
          Record this period&apos;s premium
        </Button>
      </div>
      {message && <p className="mt-2 text-xs text-gain">{message}</p>}
      {error && <p className="mt-2 text-xs text-loss">{error}</p>}
    </div>
  );
}
