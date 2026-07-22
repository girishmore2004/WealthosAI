"use client";

import { useEffect, useState, FormEvent } from "react";
import type { DocumentDTO, DocumentCategory } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { InlineEditForm, EditField } from "@/components/ui/InlineEditForm";

const CATEGORIES: DocumentCategory[] = [
  "PAN",
  "AADHAAR",
  "SALARY_SLIP",
  "FORM_16",
  "INSURANCE_POLICY",
  "LOAN_DOCUMENT",
  "MF_STATEMENT",
  "TAX_RETURN",
  "PROPERTY_PAPER",
  "BUSINESS_DOCUMENT",
  "RECEIPT",
  "BILL",
  "OTHER",
];

// Metadata only — a document's file bytes/name/size aren't editable, only category,
// tags, and expiry date (matching what PATCH /documents/:id actually accepts).
const EDIT_FIELDS: EditField[] = [
  { key: "category", label: "Category", type: "select", options: CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, " ") })) },
  { key: "tags", label: "Tags (comma-separated)" },
  { key: "expiryDate", label: "Expiry date", type: "date" },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function DocumentsPage() {
  const [documents, setDocuments] = useState<DocumentDTO[]>([]);
  const [filterCategory, setFilterCategory] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState<DocumentCategory>("OTHER");
  const [tags, setTags] = useState("");
  const [expiryDate, setExpiryDate] = useState("");

  const load = () => {
    api.documents
      .list(filterCategory || undefined)
      .then(setDocuments)
      .catch((err) => setError(err instanceof ApiError ? err.message : "Could not load documents."))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [filterCategory]);

  const onUpload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.documents.upload(file, { category, tags: tags || undefined, expiryDate: expiryDate || undefined });
      setFile(null);
      setTags("");
      setExpiryDate("");
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not upload this document.");
    } finally {
      setUploading(false);
    }
  };

  const onDownload = async (doc: DocumentDTO) => {
    try {
      const blob = await api.documents.download(doc.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = doc.fileName;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not download this file.");
    }
  };

  const onDelete = async (id: string) => {
    await api.documents.remove(id);
    load();
  };

  const onUpdate = async (id: string, values: Record<string, string | boolean>) => {
    await api.documents.update(id, {
      category: values.category as string,
      tags: (values.tags as string)
        ? (values.tags as string).split(",").map((t) => t.trim()).filter(Boolean)
        : [],
      expiryDate: (values.expiryDate as string) || undefined,
    });
    setEditingId(null);
    load();
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl text-ink">Documents</h1>
        <p className="text-sm text-ink-soft">
          PAN, Aadhaar, salary slips, policies, statements — stored securely with expiry tracking.
        </p>
      </div>

      {error && <p className="text-sm text-loss">{error}</p>}

      <Card title="Upload a document">
        <form onSubmit={onUpload} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <input
            type="file"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"
            className="rounded-sm border border-line bg-surface px-3 py-2 text-sm file:mr-2 file:rounded-sm file:border-0 file:bg-marigold-50 file:px-2 file:py-1 file:text-marigold-600"
          />
          <select value={category} onChange={(e) => setCategory(e.target.value as DocumentCategory)} className="rounded-sm border border-line bg-surface px-3 py-2 text-sm">
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c.replace(/_/g, " ")}
              </option>
            ))}
          </select>
          <Input placeholder="Tags (comma-separated)" value={tags} onChange={(e) => setTags(e.target.value)} />
          <Input type="date" placeholder="Expiry date (optional)" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} />
          <Button type="submit" disabled={uploading || !file} className="sm:col-span-2 lg:col-span-4">
            {uploading ? "Uploading…" : "Upload"}
          </Button>
        </form>
        <p className="mt-2 text-[11px] text-ink-faint">PDF, JPG, PNG, WEBP, or Word docs, up to 10MB.</p>
      </Card>

      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-faint">Filter:</span>
        <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="rounded-sm border border-line bg-surface px-3 py-1.5 text-sm">
          <option value="">All categories</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c.replace(/_/g, " ")}
            </option>
          ))}
        </select>
      </div>

      <Card title="All documents">
        {loading ? (
          <p className="text-sm text-ink-faint">Loading documents…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-ink-faint">No documents uploaded yet.</p>
        ) : (
          <ul>
            {documents.map((doc, i) => (
              <li key={doc.id} className={`py-3 ${i !== documents.length - 1 ? "ledger-rule" : ""}`}>
                {editingId === doc.id ? (
                  <InlineEditForm
                    fields={EDIT_FIELDS}
                    initialValues={{
                      category: doc.category,
                      tags: doc.tags.join(", "),
                      expiryDate: doc.expiryDate ? doc.expiryDate.slice(0, 10) : "",
                    }}
                    onSave={(values) => onUpdate(doc.id, values)}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  <div className="flex items-start justify-between">
                    <div>
                      <p className="text-sm text-ink">{doc.fileName}</p>
                      <p className="text-xs text-ink-faint">
                        {doc.category.replace(/_/g, " ")} · {formatBytes(doc.sizeBytes)}
                        {doc.expiryDate && ` · expires ${new Date(doc.expiryDate).toLocaleDateString("en-IN")}`}
                      </p>
                      {doc.tags.length > 0 && (
                        <div className="mt-1 flex gap-1">
                          {doc.tags.map((t) => (
                            <span key={t} className="rounded-sm bg-paper px-1.5 py-0.5 text-[10px] text-ink-faint">
                              {t}
                            </span>
                          ))}
                        </div>
                      )}
                      {doc.summary && <p className="mt-1 text-xs text-ink-soft">{doc.summary}</p>}
                    </div>
                    <div className="flex shrink-0 items-center gap-3">
                      <button onClick={() => onDownload(doc)} className="text-xs text-marigold-600 hover:underline">
                        Download
                      </button>
                      <button onClick={() => setEditingId(doc.id)} className="text-xs text-ink-faint hover:text-marigold-600">
                        Edit
                      </button>
                      <button onClick={() => onDelete(doc.id)} className="text-xs text-ink-faint hover:text-loss">
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <p className="text-[11px] text-ink-faint">
        Text extraction (OCR) is a mocked placeholder in this build — files are stored and retrievable for real, but
        automatic text/summary extraction isn&apos;t wired to a real OCR engine yet.
      </p>
    </div>
  );
}
