"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import type { CoachExecutionActionDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { CoachAnswer } from "@/components/coach/CoachAnswer";
import { CoachDetailsPanel } from "@/components/coach/CoachDetailsPanel";
import { ConfirmPlanDialog } from "@/components/coach/ConfirmPlanDialog";
import { ChatTurn, EXAMPLE_QUESTIONS, turnFromRun } from "@/components/coach/coach-utils";

const MAX_QUESTION_LENGTH = 500;

type Pane = "chat" | "details";

// AI Coach: one chat over the user's own verified data. Answers come from the existing Coach 2.0 endpoint, which
// reads real records, runs deterministic calculations (and Scenario Studio / AI Search where a question needs
// them) and returns a structured report. Nothing is written by asking a question; creating a plan needs an
// explicit confirmation in a dialog.
export default function CoachPage() {
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [question, setQuestion] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; question: string } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pane, setPane] = useState<Pane>("chat");
  const [planAction, setPlanAction] = useState<CoachExecutionActionDTO | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.coach2
      .history(20)
      .then((runs) => {
        if (cancelled) return;
        // The API returns newest first; a chat reads oldest first.
        const loaded = runs.map(turnFromRun).reverse();
        setTurns(loaded);
        const latestWithReport = [...loaded].reverse().find((t) => t.report);
        if (latestWithReport) setSelectedId(latestWithReport.id);
      })
      .catch(() => {})
      .finally(() => !cancelled && setLoadingHistory(false));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [turns.length, pending]);

  const ask = useCallback(
    async (raw: string) => {
      const q = raw.trim();
      if (!q || pending) return;
      setPending(q);
      setError(null);
      setNotice(null);
      try {
        const result = await api.coach2.ask(q);
        const turn: ChatTurn = {
          id: `local-${Date.now()}`,
          question: result.question,
          answer: result.answer,
          report: result.report ?? null,
          createdAt: new Date().toISOString(),
          staleAdviceNote: result.staleAdviceNote,
        };
        setTurns((prev) => [...prev, turn]);
        if (turn.report) setSelectedId(turn.id);
        setQuestion("");
        setPane("chat");
      } catch (err) {
        setError({ message: err instanceof ApiError ? err.message : "The Coach could not be reached. Nothing was changed.", question: q });
      } finally {
        setPending(null);
      }
    },
    [pending],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  const selected = turns.find((t) => t.id === selectedId)?.report ?? null;
  const empty = !loadingHistory && turns.length === 0 && !pending;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-ink sm:text-3xl">AI Coach</h1>
        <p className="text-sm text-ink-soft">Ask about your own money. Answers use your recorded data and exact calculations, and show what they relied on, what was assumed and what is missing.</p>
      </div>

      {/* Small screens: switch between the conversation and the details of the selected answer. */}
      <div className="flex rounded-md border border-line bg-surface p-1 shadow-card lg:hidden" role="tablist" aria-label="Coach view">
        {(["chat", "details"] as const).map((p) => (
          <button key={p} role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={`flex-1 rounded-md px-3 py-1.5 text-xs transition-colors ${pane === p ? "bg-marigold-50 font-medium text-marigold-600" : "text-ink-soft hover:text-ink"}`}>
            {p === "chat" ? "Conversation" : "Details"}
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className={`${pane === "details" ? "hidden lg:block" : ""} min-w-0`} aria-label="Conversation">
          <div className="space-y-6">
            {loadingHistory && <p className="text-sm text-ink-faint">Loading your conversation…</p>}

            {empty && (
              <div className="panel p-5 sm:p-6">
                <h2 className="font-display text-lg text-ink">What would you like to know?</h2>
                <p className="mt-1 text-sm text-ink-soft">Try one of these, or ask in your own words.</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {EXAMPLE_QUESTIONS.map((q) => (
                    <button key={q} onClick={() => void ask(q)} className="rounded-full border border-line bg-surface-muted px-3 py-1.5 text-xs text-ink-soft transition-colors hover:border-marigold-500 hover:text-marigold-600">
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((t) => (
              <CoachAnswer
                key={t.id}
                turn={t}
                selected={t.id === selectedId}
                busy={pending !== null}
                onSelect={() => {
                  setSelectedId(t.id);
                  setPane("details");
                }}
                onAction={setPlanAction}
                onFollowUp={(q) => void ask(q)}
              />
            ))}

            {pending && (
              <div className="space-y-3" aria-live="polite">
                <div className="flex justify-end">
                  <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-marigold-50 px-4 py-2.5 text-sm text-ink">{pending}</p>
                </div>
                <div className="panel p-4 text-sm text-ink-soft">Reading your records and working it out…</div>
              </div>
            )}

            {error && (
              <div role="alert" className="panel border-loss/40 p-4">
                <p className="text-sm text-loss">{error.message}</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="secondary" onClick={() => void ask(error.question)}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setError(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            )}

            {notice && (
              <p role="status" className="panel border-gain/40 p-3 text-sm text-gain">
                {notice}
              </p>
            )}
            <div ref={bottomRef} />
          </div>

          <form onSubmit={onSubmit} className="sticky bottom-0 mt-4 space-y-1 bg-paper/95 py-3 backdrop-blur">
            <div className="flex gap-2">
              <Input
                aria-label="Ask the Coach"
                placeholder="Ask about spending, savings, goals, loans, retirement or a what-if…"
                value={question}
                maxLength={MAX_QUESTION_LENGTH}
                onChange={(e) => setQuestion(e.target.value)}
                disabled={pending !== null}
              />
              <Button type="submit" disabled={pending !== null || !question.trim()}>
                {pending ? "Working…" : "Ask"}
              </Button>
            </div>
            <p className="text-[11px] text-ink-faint">
              {question.length > MAX_QUESTION_LENGTH - 60 ? `${question.length}/${MAX_QUESTION_LENGTH} · ` : ""}Decision support based on your recorded data, not financial advice.
            </p>
          </form>
        </section>

        <aside className={`${pane === "chat" ? "hidden lg:block" : ""} min-w-0`} aria-label="Answer details">
          <div className="panel lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
            <CoachDetailsPanel report={selected} />
          </div>
        </aside>
      </div>

      <ConfirmPlanDialog
        action={planAction}
        onClose={() => setPlanAction(null)}
        onCreated={(message) => {
          setNotice(message);
        }}
      />
    </div>
  );
}
