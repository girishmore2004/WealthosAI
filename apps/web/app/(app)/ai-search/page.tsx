"use client";

import { useState, FormEvent } from "react";
import type { AiSearchResultDTO, AiSourceType } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const SOURCE_TYPES: { value: AiSourceType; label: string }[] = [
  { value: "DOCUMENT", label: "Documents" },
  { value: "REPORT", label: "Reports" },
  { value: "COACH_INTERACTION", label: "Coach history" },
  { value: "ALERT", label: "Alerts" },
  { value: "SNAPSHOT", label: "Current snapshot" },
];

const SUGGESTED_QUERIES = [
  "What does my home loan agreement say about prepayment?",
  "How has my spending changed recently?",
  "What insurance policies do I have on file?",
];

export default function AiSearchPage() {
  const [query, setQuery] = useState("");
  const [selectedSourceTypes, setSelectedSourceTypes] = useState<AiSourceType[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [result, setResult] = useState<AiSearchResultDTO | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexMessage, setReindexMessage] = useState<string | null>(null);

  const toggleSourceType = (type: AiSourceType) => {
    setSelectedSourceTypes((prev) => (prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type]));
  };

  const runSearch = async (q: string) => {
    if (!q.trim()) return;
    setSearching(true);
    setError(null);
    try {
      const searchResult = await api.aiSearch.search(q, {
        sourceTypes: selectedSourceTypes.length > 0 ? selectedSourceTypes : undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      setResult(searchResult);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Search couldn't be completed right now.");
    } finally {
      setSearching(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    runSearch(query);
  };

  const onReindex = async () => {
    setReindexing(true);
    setReindexMessage(null);
    try {
      const { jobId } = await api.aiSearch.reindex();
      setReindexMessage(`Reindex started (job ${jobId}). This runs in the background — search again in a minute or two.`);
    } catch (err) {
      setReindexMessage(err instanceof ApiError ? err.message : "Couldn't start reindexing right now.");
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink">AI Search</h1>
          <p className="text-sm text-ink-soft">
            Searches across your documents, reports, coach history, and alerts — answers are grounded only in
            what it actually finds, with sources cited, and it says so plainly when it finds nothing.
          </p>
        </div>
        <Button variant="secondary" onClick={onReindex} disabled={reindexing} className="shrink-0">
          {reindexing ? "Starting…" : "Reindex my data"}
        </Button>
      </div>
      {reindexMessage && <p className="text-xs text-ink-faint">{reindexMessage}</p>}

      <Card>
        <form onSubmit={onSubmit} className="space-y-3">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask about your documents, reports, coach history, or alerts…"
          />

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-ink-faint">Filter by source:</span>
            {SOURCE_TYPES.map((s) => (
              <button
                type="button"
                key={s.value}
                onClick={() => toggleSourceType(s.value)}
                className={`rounded-full border px-3 py-1 text-xs ${
                  selectedSourceTypes.includes(s.value)
                    ? "border-marigold-500 bg-marigold-50 text-marigold-600"
                    : "border-line text-ink-soft"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs uppercase tracking-wide text-ink-faint">Date range:</span>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="w-auto" />
            <span className="text-xs text-ink-faint">to</span>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="w-auto" />
          </div>

          <Button type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>

        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED_QUERIES.map((q) => (
            <button
              key={q}
              onClick={() => {
                setQuery(q);
                runSearch(q);
              }}
              disabled={searching}
              className="rounded-sm border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-marigold-500 hover:text-marigold-600"
            >
              {q}
            </button>
          ))}
        </div>
      </Card>

      {error && (
        <Card className="border-loss">
          <p className="text-sm text-loss">{error}</p>
        </Card>
      )}

      {result && (
        <div className="space-y-4">
          <Card eyebrow={result.hasEvidence ? "Answer" : "No evidence found"}>
            <p className={`text-sm ${result.hasEvidence ? "text-ink" : "text-ink-soft italic"}`}>{result.answer}</p>
            <div className="mt-3 flex flex-wrap gap-4 text-xs text-ink-faint">
              <ConfidenceBadge label="Retrieval confidence" value={result.retrievalConfidence} />
              {result.answerConfidence !== null && (
                <ConfidenceBadge label="Answer confidence" value={result.answerConfidence} />
              )}
            </div>
          </Card>

          <Card eyebrow="Why these sources were used" title="How this search worked">
            <p className="text-sm text-ink-soft">{result.explanation}</p>
            {result.isMultiHop && result.subQuestions.length > 0 && (
              <div className="mt-2">
                <p className="text-xs uppercase tracking-wide text-ink-faint">Broken into</p>
                <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
                  {result.subQuestions.map((sq) => (
                    <li key={sq}>{sq}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>

          {result.citedSources.length > 0 && (
            <Card eyebrow={`${result.citedSources.length} cited source${result.citedSources.length > 1 ? "s" : ""}`}>
              <div className="space-y-3">
                {result.citedSources.map((source) => (
                  <div key={source.chunkId} className="border-b border-line pb-3 last:border-b-0 last:pb-0">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-ink">{source.title}</p>
                      <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-ink-faint">
                        {source.sourceType.replace("_", " ").toLowerCase()}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-ink-soft">{source.snippet}…</p>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceBadge({ label, value }: { label: string; value: number }) {
  const tier = value >= 0.7 ? "text-gain" : value >= 0.4 ? "text-marigold-600" : "text-loss";
  return (
    <span>
      {label}: <span className={`font-mono ${tier}`}>{Math.round(value * 100)}%</span>
    </span>
  );
}
