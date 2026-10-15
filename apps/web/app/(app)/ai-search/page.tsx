"use client";

import { useState, FormEvent, ReactNode } from "react";
import type { AiCitedSourceDTO, AiSearchResultDTO, AiSourceType } from "@wealthos/types";
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
  { value: "FINANCIAL_FACT", label: "Your records" },
];

const SUGGESTED_QUERIES = [
  "What does my home loan agreement say about prepayment?",
  "How has my spending changed recently?",
  "What insurance policies do I have on file?",
];

type EvidenceSufficiency = "sufficient" | "partial" | "insufficient" | "unverified" | "needs_clarification";
type HallucinationRisk = "unmeasured" | "low" | "medium" | "high";

/** What the API actually returns. The shared DTO only types the original fields; the rest are sent by the
 * API on every search and are optional here so an older API response still renders. */
type AiSearchView = Omit<AiSearchResultDTO, "citedSources"> & {
  citedSources: (AiCitedSourceDTO & { confidence?: "high" | "medium" | "low" })[];
  groundingScore?: number | null;
  hallucinationRisk?: HallucinationRisk;
  evidenceSufficiency?: EvidenceSufficiency;
  retrievalMode?: "hybrid" | "lexical";
  timingsMs?: { plan: number; retrieve: number; rerank: number; synthesize: number; total: number };
  liveAnswer?: { intent: string; answer: string; tools: string[] };
  understanding?: {
    intent?: string;
    dateRange?: { matchedText: string };
    amount?: { matchedText: string };
    negations?: string[];
  };
};

export default function AiSearchPage() {
  const [query, setQuery] = useState("");
  const [selectedSourceTypes, setSelectedSourceTypes] = useState<AiSourceType[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [result, setResult] = useState<AiSearchView | null>(null);
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
      setResult(searchResult as AiSearchView);
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
      const { jobId, status, reused } = await api.aiSearch.reindex();
      setReindexMessage(
        status === "FAILED"
          ? `The last reindex (job ${jobId}) failed. Try again in a little while.`
          : status === "DONE"
            ? `Your data was already reindexed this hour (job ${jobId}) — search results are up to date with that run.`
            : reused
              ? `A reindex is already in progress (job ${jobId}). Search again in a minute or two.`
              : `Reindex started (job ${jobId}). This runs in the background — search again in a minute or two.`,
      );
    } catch (err) {
      setReindexMessage(err instanceof ApiError ? err.message : "Couldn't start reindexing right now.");
    } finally {
      setReindexing(false);
    }
  };

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink sm:text-3xl">AI Search</h1>
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
            <span className="stat-label">Filter by source:</span>
            {SOURCE_TYPES.map((s) => (
              <button
                type="button"
                key={s.value}
                onClick={() => toggleSourceType(s.value)}
                className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                  selectedSourceTypes.includes(s.value)
                    ? "border-marigold-500 bg-marigold-50 font-medium text-marigold-600"
                    : "border-line text-ink-soft hover:text-ink"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="stat-label">Date range:</span>
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
              className="rounded-full border border-line bg-surface-muted px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-marigold-500 hover:text-marigold-600"
            >
              {q}
            </button>
          ))}
        </div>
      </Card>

      {error && (
        <div className="panel border-loss/30 bg-loss/5 p-5 text-sm text-loss">{error}</div>
      )}

      {result && <SearchResult result={result} />}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------------------------------------

function SearchResult({ result }: { result: AiSearchView }) {
  const hasSources = result.citedSources.length > 0;
  return (
    <div className="space-y-4">
      <Card
        eyebrow={result.hasEvidence ? "Answer" : "No evidence found"}
        action={result.evidenceSufficiency ? <EvidenceBadge value={result.evidenceSufficiency} /> : undefined}
      >
        {result.hasEvidence ? (
          <AnswerBody text={result.answer} />
        ) : (
          <p className="text-sm italic text-ink-soft">{result.answer}</p>
        )}
      </Card>

      {result.hasEvidence && <Analytics result={result} />}

      {hasSources && (
        <Card eyebrow={`${result.citedSources.length} cited source${result.citedSources.length > 1 ? "s" : ""}`} title="Where this came from">
          <ol className="space-y-3">
            {result.citedSources.map((source, i) => (
              <li key={source.chunkId} className="flex gap-3 border-b border-line pb-3 last:border-b-0 last:pb-0">
                <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface-muted font-mono text-[11px] text-ink-soft">
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-ink">{source.title}</p>
                    <div className="flex items-center gap-2">
                      {source.confidence && <SourceConfidenceBadge value={source.confidence} />}
                      <span className="badge badge-info">{sourceLabel(source.sourceType)}</span>
                    </div>
                  </div>
                  <p className="mt-1 break-words text-xs text-ink-soft">{source.snippet}…</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {/* When nothing was found, the explanation carries the reason (for example how many uploaded documents
          are still waiting for text extraction), so it starts open instead of folded away. */}
      <details className="panel group p-5 sm:p-6" open={!result.hasEvidence}>
        <summary className="cursor-pointer list-none">
          <p className="stat-label mb-1">Why these sources were used</p>
          <span className="font-display text-lg text-ink">How this search worked</span>
        </summary>
        <div className="mt-4 space-y-3">
          <p className="text-sm text-ink-soft">{result.explanation}</p>
          {result.isMultiHop && result.subQuestions.length > 0 && (
            <div>
              <p className="stat-label">Broken into</p>
              <ul className="mt-1 list-disc pl-5 text-sm text-ink-soft">
                {result.subQuestions.map((sq) => (
                  <li key={sq}>{sq}</li>
                ))}
              </ul>
            </div>
          )}
          <Understanding result={result} />
        </div>
      </details>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Answer text. The API writes the answer in a small Markdown subset: plain sentences, **bold** labels, "- "
// bullets and [n] markers that point at the numbered cited sources below. It is rendered as React elements
// (never as HTML), so nothing in the text can inject markup.
// ---------------------------------------------------------------------------------------------------------

type AnswerBlock = { kind: "p"; text: string } | { kind: "h"; text: string } | { kind: "ul"; items: string[] };

function parseAnswer(text: string): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let list: string[] | null = null;
  const flush = () => {
    if (list) blocks.push({ kind: "ul", items: list });
    list = null;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const bullet = line.match(/^[-*•]\s+(.*)$/);
    if (bullet) {
      if (!list) list = [];
      list.push(bullet[1]);
      continue;
    }
    flush();
    const heading = line.match(/^\*\*([^*]+?)\*\*:?$/);
    blocks.push(heading ? { kind: "h", text: heading[1] } : { kind: "p", text: line });
  }
  flush();
  return blocks;
}

function AnswerBody({ text }: { text: string }) {
  const blocks = parseAnswer(text);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-ink">
      {blocks.map((block, i) => {
        if (block.kind === "h") {
          return (
            <p key={i} className="stat-label !mb-0 border-t border-line pt-3 first:border-t-0 first:pt-0">
              {block.text}
            </p>
          );
        }
        if (block.kind === "ul") {
          return (
            <ul key={i} className="space-y-1.5">
              {block.items.map((item, j) => (
                <li key={j} className="flex gap-2">
                  <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-marigold-500" />
                  <span className="min-w-0">
                    <Inline text={item} />
                  </span>
                </li>
              ))}
            </ul>
          );
        }
        return (
          <p key={i}>
            <Inline text={block.text} />
          </p>
        );
      })}
    </div>
  );
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\d+\])/g).filter(Boolean);
  return (
    <>
      {parts.map((part, i) => {
        if (part.length > 4 && part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-ink">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (/^\[\d+\]$/.test(part)) {
          return (
            <sup
              key={i}
              title={`Source ${part.slice(1, -1)} below`}
              className="ml-0.5 rounded bg-surface-muted px-1 font-mono text-[10px] text-ink-faint"
            >
              {part.slice(1, -1)}
            </sup>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------------------------------------

function Analytics({ result }: { result: AiSearchView }) {
  const grounding = typeof result.groundingScore === "number" ? result.groundingScore : null;
  return (
    <Card eyebrow="Search analytics" title="How reliable is this answer?">
      <div className="grid gap-3 sm:grid-cols-3">
        <Meter
          label="Retrieval confidence"
          value={result.retrievalConfidence}
          hint="How well your question matched the stored text, combined with the ranker's own confidence."
        />
        {result.answerConfidence !== null && (
          <Meter
            label="Answer confidence"
            value={result.answerConfidence}
            hint="The model's own confidence, never shown higher than the grounding check below."
          />
        )}
        {grounding !== null && (
          <Meter label="Grounding" value={grounding} hint="Share of the figures in the answer that appear in your sources." />
        )}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-ink-soft">
        {result.hallucinationRisk && (
          <span className="flex items-center gap-2">
            Made-up-figure risk <RiskBadge value={result.hallucinationRisk} />
          </span>
        )}
        {result.retrievalMode && (
          <span className="flex items-center gap-2">
            Search mode{" "}
            <span className="badge badge-info">{result.retrievalMode === "hybrid" ? "meaning + keywords" : "keywords only"}</span>
          </span>
        )}
        {result.liveAnswer && (
          <span className="flex items-center gap-2">
            Figures <span className="badge badge-success">checked against your live records</span>
          </span>
        )}
      </div>

      {result.citedSources.length > 0 && <SourceMix sources={result.citedSources} />}
      {result.timingsMs && <TimingBar timings={result.timingsMs} />}
    </Card>
  );
}

function Meter({ label, value, hint }: { label: string; value: number; hint: string }) {
  const clamped = Math.max(0, Math.min(1, value));
  const pct = Math.round(clamped * 100);
  const textTone = clamped >= 0.7 ? "text-gain" : clamped >= 0.4 ? "text-warn" : "text-loss";
  const barTone = clamped >= 0.7 ? "bg-gain" : clamped >= 0.4 ? "bg-warn" : "bg-loss";
  return (
    <div className="rounded-lg border border-line bg-surface-muted p-4">
      <p className="stat-label">{label}</p>
      <p className={`mt-1 font-mono text-2xl ${textTone}`}>{pct}%</p>
      <div
        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
      >
        <div className={`h-full rounded-full ${barTone}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-[11px] leading-snug text-ink-faint">{hint}</p>
    </div>
  );
}

function SourceMix({ sources }: { sources: AiSearchView["citedSources"] }) {
  const counts = new Map<string, number>();
  for (const s of sources) counts.set(s.sourceType, (counts.get(s.sourceType) ?? 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return (
    <Section title="Where the evidence came from">
      <div className="space-y-1.5">
        {rows.map(([type, n]) => (
          <div key={type} className="flex items-center gap-3 text-xs">
            <span className="w-28 shrink-0 text-ink-soft">{sourceLabel(type)}</span>
            <div className="h-2 flex-1 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-marigold-500" style={{ width: `${(n / sources.length) * 100}%` }} />
            </div>
            <span className="w-6 text-right font-mono text-ink-faint">{n}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

const TIMING_STAGES: { key: "plan" | "retrieve" | "rerank" | "synthesize"; label: string; tone: string }[] = [
  { key: "plan", label: "Understanding the question", tone: "bg-marigold-500" },
  { key: "retrieve", label: "Searching your data", tone: "bg-marigold-500/70" },
  { key: "rerank", label: "Ranking the matches", tone: "bg-marigold-500/45" },
  { key: "synthesize", label: "Writing the answer", tone: "bg-marigold-500/25" },
];

function TimingBar({ timings }: { timings: NonNullable<AiSearchView["timingsMs"]> }) {
  const parts = TIMING_STAGES.map((s) => ({ ...s, ms: Math.max(0, timings[s.key]) }));
  const sum = parts.reduce((n, p) => n + p.ms, 0);
  if (sum <= 0) return null;
  return (
    <Section title={`Where the ${seconds(timings.total)} went`}>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-line" role="img" aria-label="Time spent per stage">
        {parts.map((p) => (
          <div key={p.key} className={`h-full ${p.tone}`} style={{ width: `${(p.ms / sum) * 100}%` }} title={`${p.label}: ${seconds(p.ms)}`} />
        ))}
      </div>
      <ul className="mt-2 grid gap-x-4 gap-y-1 text-[11px] text-ink-soft sm:grid-cols-2">
        {parts.map((p) => (
          <li key={p.key} className="flex items-center gap-2">
            <span aria-hidden className={`h-2 w-2 shrink-0 rounded-full ${p.tone}`} />
            <span className="flex-1">{p.label}</span>
            <span className="font-mono text-ink-faint">{seconds(p.ms)}</span>
          </li>
        ))}
      </ul>
    </Section>
  );
}

function Understanding({ result }: { result: AiSearchView }) {
  const u = result.understanding;
  const chips: string[] = [];
  if (u?.intent) chips.push(`Topic: ${u.intent}`);
  if (u?.dateRange) chips.push(`Period: ${u.dateRange.matchedText}`);
  if (u?.amount) chips.push(`Amount: ${u.amount.matchedText}`);
  for (const n of u?.negations ?? []) chips.push(`Excluding: ${n}`);
  if (result.rewrittenQueries.length > 1) chips.push(`${result.rewrittenQueries.length} phrasings searched`);
  if (chips.length === 0) return null;
  return (
    <div>
      <p className="stat-label">What was read from your question</p>
      <div className="mt-1 flex flex-wrap gap-2">
        {chips.map((c) => (
          <span key={c} className="rounded-full border border-line bg-surface-muted px-2.5 py-0.5 text-[11px] text-ink-soft">
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5 border-t border-line pt-4">
      <p className="stat-label mb-2">{title}</p>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------
// Badges and helpers
// ---------------------------------------------------------------------------------------------------------

function EvidenceBadge({ value }: { value: EvidenceSufficiency }) {
  const map: Record<EvidenceSufficiency, { label: string; cls: string }> = {
    sufficient: { label: "Fully supported by your data", cls: "badge-success" },
    partial: { label: "Partly supported", cls: "badge-warning" },
    unverified: { label: "Figures not verified", cls: "badge-warning" },
    insufficient: { label: "Not enough evidence", cls: "badge-critical" },
    needs_clarification: { label: "Needs a clearer question", cls: "badge-info" },
  };
  const { label, cls } = map[value];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function RiskBadge({ value }: { value: HallucinationRisk }) {
  const map: Record<HallucinationRisk, { label: string; cls: string }> = {
    low: { label: "Low", cls: "badge-success" },
    medium: { label: "Medium", cls: "badge-warning" },
    high: { label: "High", cls: "badge-critical" },
    unmeasured: { label: "Not measured", cls: "badge-info" },
  };
  const { label, cls } = map[value];
  return <span className={`badge ${cls}`}>{label}</span>;
}

function SourceConfidenceBadge({ value }: { value: "high" | "medium" | "low" }) {
  const cls = value === "high" ? "badge-success" : value === "medium" ? "badge-warning" : "badge-critical";
  return <span className={`badge ${cls}`}>{value} match</span>;
}

function sourceLabel(type: string): string {
  return SOURCE_TYPES.find((s) => s.value === type)?.label ?? type.replace(/_/g, " ").toLowerCase();
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}
