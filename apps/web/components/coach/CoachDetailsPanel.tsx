"use client";

import type { CoachReportDTO } from "@wealthos/types";
import { CoachChart } from "./CoachChart";
import { QUALITY_LABEL } from "./coach-utils";

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="group border-b border-line py-3 last:border-0">
      <summary className="stat-label cursor-pointer select-none">{title}</summary>
      <div className="mt-2.5 space-y-2.5">{children}</div>
    </details>
  );
}

const qualityBadge = (q: string) => (q === "verified" || q === "verified_zero" ? "badge badge-success" : q === "missing" || q === "failed_source" || q === "empty" ? "badge badge-critical" : "badge badge-warning");

/** The supporting detail for one answer: figures used, charts, calculations, sources, assumptions, risks and gaps. */
export function CoachDetailsPanel({ report }: { report: CoachReportDTO | null }) {
  if (!report) {
    return <p className="p-4 text-sm text-ink-faint">Ask a question to see the figures, calculations and sources behind the answer.</p>;
  }
  const r = report;
  return (
    <div className="px-4 py-1 sm:px-5" aria-label="Details for the selected answer">
      {r.financialSnapshot.items.length > 0 && (
        <Section title="Financial snapshot">
          <dl className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {r.financialSnapshot.items.map((i) => (
              <div key={i.key} className="rounded-md bg-surface-muted p-2.5">
                <dt className="text-[11px] text-ink-faint">{i.label}</dt>
                <dd className={`font-mono text-sm ${i.value === null && i.unit !== "text" ? "text-ink-faint" : "text-ink"}`}>{i.display}</dd>
                <span className={`${qualityBadge(i.quality)} mt-1 inline-block`}>{QUALITY_LABEL[i.quality] ?? i.quality}</span>
                {i.note && <p className="mt-1 text-[11px] text-ink-faint">{i.note}</p>}
              </div>
            ))}
          </dl>
        </Section>
      )}

      {r.charts.length > 0 && (
        <Section title="Charts">
          {r.charts.map((c) => (
            <CoachChart key={c.id} chart={c} />
          ))}
        </Section>
      )}

      {r.scenarioComparison && (
        <Section title={`Scenario: ${r.scenarioComparison.source === "simulator" ? "Simulator" : "Scenario Studio"}`}>
          <p className="text-xs text-ink-soft">{r.scenarioComparison.label}</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-ink-faint">
                  <th className="py-1 pr-2 font-normal">Metric</th>
                  <th className="py-1 pr-2 font-normal">Now</th>
                  <th className="py-1 pr-2 font-normal">With change</th>
                  <th className="py-1 font-normal">Difference</th>
                </tr>
              </thead>
              <tbody>
                {r.scenarioComparison.rows.map((row) => (
                  <tr key={row.metric} className="border-t border-line">
                    <td className="py-1.5 pr-2 text-ink">{row.metric}</td>
                    <td className="py-1.5 pr-2 font-mono text-ink-soft">{row.baseline}</td>
                    <td className="py-1.5 pr-2 font-mono text-ink-soft">{row.proposed}</td>
                    <td className={`py-1.5 font-mono ${row.direction === "better" ? "text-gain" : row.direction === "worse" ? "text-loss" : "text-ink-soft"}`}>{row.delta}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.scenarioComparison.narrative && <p className="text-xs text-ink-soft">{r.scenarioComparison.narrative}</p>}
        </Section>
      )}

      {r.calculations.length > 0 && (
        <Section title="Calculations" defaultOpen={false}>
          {r.calculations.map((c) => (
            <div key={c.id} className="rounded-md border border-line p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-ink">{c.label}</p>
                <p className="font-mono text-ink">{c.display}</p>
              </div>
              <p className="mt-1 text-ink-faint">Formula: {c.formula}</p>
              <ul className="mt-1 text-ink-soft">
                {c.inputs.map((i) => (
                  <li key={i.label}>
                    {i.label}: <span className="font-mono">{i.value}</span>
                  </li>
                ))}
              </ul>
              {c.period && <p className="mt-1 text-ink-faint">Period: {c.period}</p>}
              {c.assumptions.map((a) => (
                <p key={a} className="mt-1 text-ink-faint">
                  Assumes: {a}
                </p>
              ))}
              <span className={`${qualityBadge(c.quality)} mt-1.5 inline-block`}>{QUALITY_LABEL[c.quality] ?? c.quality}</span>
            </div>
          ))}
        </Section>
      )}

      {r.predictions.length > 0 && (
        <Section title="Projections">
          {r.predictions.map((p) => (
            <div key={p.id} className="text-xs">
              <p className="text-ink">
                {p.label}: <span className="font-mono">{p.display}</span>
              </p>
              <p className="text-ink-faint">
                Horizon: {p.horizon}. {p.assumptions.join(" ")}
              </p>
            </div>
          ))}
        </Section>
      )}

      {(r.evidenceCards.length > 0 || r.citations.length > 0) && (
        <Section title="Evidence and sources">
          {r.evidenceCards.map((e) => (
            <div key={e.id} className="rounded-md border border-line p-2.5 text-xs">
              <div className="flex items-start justify-between gap-2">
                <p className="font-medium text-ink">{e.sourceName}</p>
                <span className={qualityBadge(e.quality)}>{QUALITY_LABEL[e.quality] ?? e.quality}</span>
              </div>
              <p className="text-ink-faint">
                {e.sourceType}
                {e.period ? ` · ${e.period}` : ""}
                {e.value ? ` · ${e.value}` : ""}
              </p>
              {e.excerpt && <blockquote className="mt-1.5 border-l-2 border-line pl-2 text-ink-soft">{e.excerpt}</blockquote>}
              {e.calculationBasis && <p className="mt-1 text-ink-faint">{e.calculationBasis}</p>}
            </div>
          ))}
          {r.citations.length > 0 && <p className="text-[11px] text-ink-faint">Cited passages: {r.citations.map((c) => c.title).join(", ")}</p>}
        </Section>
      )}

      {r.assumptions.length > 0 && (
        <Section title="Assumptions" defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
            {r.assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Section>
      )}

      {r.risks.length > 0 && (
        <Section title="Risks and limits" defaultOpen={false}>
          <ul className="list-disc space-y-1 pl-4 text-xs text-ink-soft">
            {r.risks.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Section>
      )}

      {r.dataGaps.length > 0 && (
        <Section title="Missing or unavailable data">
          <ul className="space-y-1.5 text-xs">
            {r.dataGaps.map((g, i) => (
              <li key={`${g.code}-${i}`} className="rounded-md bg-surface-muted p-2.5">
                <p className="text-ink">{g.message}</p>
                <p className="text-ink-faint">{g.impact}</p>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="How this was produced" defaultOpen={false}>
        <ul className="space-y-1 text-xs text-ink-soft">
          {r.metadata.engines.map((e) => (
            <li key={e.name}>
              {e.name.replace("_", " ")}: <span className="font-medium">{e.status}</span>
              {e.detail ? <span className="text-ink-faint"> — {e.detail}</span> : null}
            </li>
          ))}
          <li className="text-ink-faint">
            Wording: {r.metadata.explanationSource === "model" ? "AI-worded, numbers verified" : "written by code"} · {r.metadata.executionMs} ms · generated {new Date(r.metadata.generatedAt).toLocaleString()}
          </li>
        </ul>
      </Section>
    </div>
  );
}
