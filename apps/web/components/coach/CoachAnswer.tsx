"use client";

import Link from "next/link";
import { useState } from "react";
import type { CoachExecutionActionDTO } from "@wealthos/types";
import { Button } from "@/components/ui/Button";
import { ChatTurn, SUFFICIENCY_LABEL, TONE_CLASS, safeInternalHref } from "./coach-utils";

/** One answered question: the direct answer first, then the reasoning the user can scan. All text is rendered as text. */
export function CoachAnswer({
  turn,
  selected,
  onSelect,
  onAction,
  onFollowUp,
  busy,
}: {
  turn: ChatTurn;
  selected: boolean;
  onSelect: () => void;
  onAction: (action: CoachExecutionActionDTO) => void;
  onFollowUp: (question: string) => void;
  busy: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const r = turn.report;

  const copy = async () => {
    const text = r?.explanation ? `${r.directAnswer}\n\n${r.explanation}` : turn.answer;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className="space-y-3" aria-label={`Answer to: ${turn.question}`}>
      <div className="flex justify-end">
        <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-marigold-50 px-4 py-2.5 text-sm text-ink">{turn.question}</p>
      </div>

      <div className={`panel space-y-3 p-4 sm:p-5 ${selected ? "ring-1 ring-marigold-500" : ""}`}>
        {r && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={SUFFICIENCY_LABEL[r.evidenceSufficiency].className}>{SUFFICIENCY_LABEL[r.evidenceSufficiency].label}</span>
            {r.metadata.partial && <span className="badge badge-warning">Some sources unavailable</span>}
            {r.answerType === "what_if" && <span className="badge badge-info">Projection</span>}
          </div>
        )}

        <p className="whitespace-pre-line text-[15px] leading-relaxed text-ink">{r ? r.directAnswer : turn.answer}</p>

        {r?.explanation && (
          <div className="rounded-md bg-surface-muted p-3">
            <p className="whitespace-pre-line text-sm text-ink-soft">{r.explanation}</p>
            <p className="mt-1.5 text-[11px] text-ink-faint">Worded by AI. Every number was checked against the calculations.</p>
          </div>
        )}

        {turn.staleAdviceNote && <p className="text-xs italic text-ink-faint">{turn.staleAdviceNote}</p>}

        {r && r.keyFindings.length > 0 && (
          <ul className="space-y-1 text-sm">
            {r.keyFindings.map((f, i) => (
              <li key={i} className={`flex gap-2 ${TONE_CLASS[f.tone] ?? "text-ink-soft"}`}>
                <span aria-hidden>•</span>
                <span>{f.text}</span>
              </li>
            ))}
          </ul>
        )}

        {r && r.recommendations.length > 0 && (
          <section aria-label="Recommendations" className="space-y-2">
            <h4 className="stat-label">What to do, in order</h4>
            <ol className="space-y-2">
              {r.recommendations.map((rec) => (
                <li key={rec.id} className="rounded-md border border-line p-3">
                  <details>
                    <summary className="cursor-pointer text-sm font-medium text-ink">
                      {rec.rank}. {rec.title} <span className="badge badge-info ml-1 align-middle">{rec.priority.level}</span>
                    </summary>
                    <div className="mt-2 space-y-1.5 text-xs text-ink-soft">
                      <p>{rec.issue}</p>
                      {rec.evidence.length > 0 && <p className="text-ink-faint">Evidence: {rec.evidence.join(" · ")}</p>}
                      <p>
                        <span className="font-medium text-ink">Why it matters:</span> {rec.whyItMatters}
                      </p>
                      <p>
                        <span className="font-medium text-ink">Next step:</span> {rec.nextStep}
                      </p>
                      {rec.estimatedImpact && (
                        <p>
                          <span className="font-medium text-ink">Estimated impact:</span> {rec.estimatedImpact.display} <span className="text-ink-faint">({rec.estimatedImpact.formula})</span>
                        </p>
                      )}
                      <p>
                        <span className="font-medium text-ink">Priority:</span> {rec.priority.reason}
                      </p>
                      <p>
                        <span className="font-medium text-ink">Feasibility:</span> {rec.feasibility}
                      </p>
                      {rec.tradeoffs.length > 0 && <p>Trade-offs: {rec.tradeoffs.join(" · ")}</p>}
                      {rec.missingInfo.length > 0 && <p className="text-ink-faint">Missing: {rec.missingInfo.join(" · ")}</p>}
                      {safeInternalHref(rec.destination?.href) && (
                        <Link href={safeInternalHref(rec.destination?.href)!} className="inline-block text-marigold-600 underline">
                          {rec.destination!.label}
                        </Link>
                      )}
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          </section>
        )}

        {r && r.actionPlan.length > 0 && (
          <section aria-label="Action plan" className="space-y-1.5">
            <h4 className="stat-label">Action plan</h4>
            <ol className="space-y-1.5 text-sm text-ink-soft">
              {r.actionPlan.map((s) => (
                <li key={s.step} className="flex gap-2">
                  <span className="font-mono text-xs text-ink-faint">{s.step}.</span>
                  <span>
                    <span className="font-medium text-ink">{s.title}</span>
                    {s.timeframe && <span className="text-ink-faint"> ({s.timeframe})</span>} — {s.detail}{" "}
                    {safeInternalHref(s.href) && (
                      <Link href={safeInternalHref(s.href)!} className="text-marigold-600 underline">
                        Open
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}

        {r && r.executionActions.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {r.executionActions.map((a) => {
              const href = safeInternalHref(a.href);
              if (a.kind === "CREATE_PLAN") {
                return (
                  <Button key={a.id} size="sm" onClick={() => onAction(a)} disabled={busy}>
                    {a.label}
                  </Button>
                );
              }
              return href ? (
                <Link key={a.id} href={href} title={a.description} className="inline-flex items-center rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:border-ink-faint hover:bg-surface-muted">
                  {a.label}
                </Link>
              ) : null;
            })}
          </div>
        )}

        {r && r.followUpSuggestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {r.followUpSuggestions.map((q) => (
              <button key={q} onClick={() => onFollowUp(q)} disabled={busy} className="rounded-full border border-line bg-surface-muted px-3 py-1 text-xs text-ink-soft transition-colors hover:border-marigold-500 hover:text-marigold-600 disabled:opacity-50">
                {q}
              </button>
            ))}
          </div>
        )}

        <div className="flex items-center gap-3 border-t border-line pt-2.5 text-xs text-ink-faint">
          <button onClick={copy} className="underline hover:text-marigold-600">
            {copied ? "Copied" : "Copy answer"}
          </button>
          {r && (
            <button onClick={onSelect} aria-pressed={selected} className="underline hover:text-marigold-600">
              {selected ? "Showing details" : "Show details"}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
