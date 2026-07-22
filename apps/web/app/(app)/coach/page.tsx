"use client";

import { useEffect, useState, FormEvent, useRef } from "react";
import type { CoachInteractionDTO, AgenticCoachRunDTO } from "@wealthos/types";
import { api, ApiError } from "@/lib/api-client";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

const SUGGESTED_QUESTIONS = [
  "What's my net worth?",
  "How's my savings rate this month?",
  "How are my goals doing?",
  "What's my tax situation?",
  "Am I on track for retirement?",
  "Do I have any insurance gaps?",
];

const SUGGESTED_ADVANCED_QUESTIONS = [
  "What should I prioritize right now?",
  "Can I afford all my goals?",
  "Should I pay off debt or invest more?",
  "Compare this month to last month.",
];

type Mode = "v1" | "v2";

export default function CoachPage() {
  const [mode, setMode] = useState<Mode>("v1");

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl text-ink">AI Coach</h1>
          <p className="text-sm text-ink-soft">
            {mode === "v1"
              ? "Grounded answers from your own data — not a general-purpose chatbot. Every answer is deterministic code, no external model involved."
              : "An explanation layer over the same grounded router — it plans, gathers facts, composes an answer, and verifies every figure before showing it to you."}
          </p>
        </div>
        <div className="flex shrink-0 rounded-sm border border-line bg-surface p-0.5">
          <button
            onClick={() => setMode("v1")}
            className={`rounded-sm px-3 py-1.5 text-xs ${mode === "v1" ? "bg-marigold-50 text-marigold-600" : "text-ink-soft"}`}
          >
            Deterministic
          </button>
          <button
            onClick={() => setMode("v2")}
            className={`rounded-sm px-3 py-1.5 text-xs ${mode === "v2" ? "bg-marigold-50 text-marigold-600" : "text-ink-soft"}`}
          >
            Advanced
          </button>
        </div>
      </div>

      {mode === "v1" ? <DeterministicCoach /> : <AdvancedCoach />}
    </div>
  );
}

function DeterministicCoach() {
  const [history, setHistory] = useState<CoachInteractionDTO[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.coach.history().then(setHistory).catch(() => {}).finally(() => setLoadingHistory(false));
  };

  useEffect(load, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.coach.ask(q);
      setHistory((prev) => [result, ...prev]);
      setQuestion("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the coach right now.");
    } finally {
      setAsking(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  return (
    <div className="space-y-6">
      <Card>
        <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">Try asking</p>
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => ask(q)}
              disabled={asking}
              className="rounded-sm border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-marigold-500 hover:text-marigold-600"
            >
              {q}
            </button>
          ))}
        </div>
      </Card>

      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          placeholder="Ask about your net worth, goals, tax, retirement, insurance, spending…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" disabled={asking || !question.trim()}>
          {asking ? "Thinking…" : "Ask"}
        </Button>
      </form>
      {error && <p className="text-sm text-loss">{error}</p>}

      <div className="space-y-3">
        {!loadingHistory && history.length === 0 && !asking && (
          <p className="text-sm text-ink-faint">No questions asked yet — try one of the suggestions above.</p>
        )}
        {history.map((h) => (
          <Card key={h.id} className={h.wasRefused ? "border-marigold-400" : undefined}>
            <p className="text-sm font-medium text-ink">{h.question}</p>
            <p className="mt-2 text-sm text-ink-soft">{h.answer}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              {h.wasRefused ? (
                <span className="rounded-sm bg-marigold-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-marigold-600">
                  Unsupported question
                </span>
              ) : (
                h.dataSources.map((s) => (
                  <span key={s} className="rounded-sm bg-paper px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                    source: {s}
                  </span>
                ))
              )}
            </div>
          </Card>
        ))}
        <div ref={bottomRef} />
      </div>

      <p className="text-[11px] text-ink-faint">
        Every answer is generated by deterministic rules over your own logged data — there is no external AI model
        involved, and every figure traces back to a specific module (shown above as &quot;source&quot;). This is
        decision support, not financial advice.
      </p>
    </div>
  );
}

const INTENT_FILTERS: { label: string; value: string | null }[] = [
  { label: "All", value: null },
  { label: "Prioritize", value: "prioritize_actions" },
  { label: "Goal conflict", value: "goal_conflict" },
  { label: "Risk tradeoff", value: "risk_tradeoff" },
  { label: "Compare periods", value: "compare_periods" },
  { label: "General search", value: "general_search" },
];

function AdvancedCoach() {
  const [history, setHistory] = useState<AgenticCoachRunDTO[]>([]);
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [intentFilter, setIntentFilter] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = () => {
    api.coach2.history().then(setHistory).catch(() => {}).finally(() => setLoadingHistory(false));
  };

  useEffect(load, []);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history.length]);

  const ask = async (q: string) => {
    if (!q.trim()) return;
    setAsking(true);
    setError(null);
    try {
      const result = await api.coach2.ask(q);
      setHistory((prev) => [
        {
          id: `pending-${Date.now()}`,
          question: result.question,
          path: result.path,
          matchedIntent: result.matchedIntent,
          advancedIntent: result.advancedIntent,
          plan: result.plan,
          facts: result.facts,
          citedSources: result.citedSources,
          answer: result.answer,
          confidence: String(result.confidence),
          verificationPassed: result.verificationPassed,
          staleAdviceNote: result.staleAdviceNote,
          createdAt: new Date().toISOString(),
        },
        ...prev,
      ]);
      setQuestion("");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not reach the coach right now.");
    } finally {
      setAsking(false);
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    ask(question);
  };

  const toggleExpanded = (id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const filtered = intentFilter
    ? history.filter((h) => h.advancedIntent === intentFilter || h.matchedIntent === intentFilter)
    : history;

  return (
    <div className="space-y-6">
      <Card>
        <p className="mb-2 text-xs uppercase tracking-wide text-ink-faint">Try asking</p>
        <div className="flex flex-wrap gap-2">
          {SUGGESTED_ADVANCED_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => ask(q)}
              disabled={asking}
              className="rounded-sm border border-line px-3 py-1.5 text-xs text-ink-soft hover:border-marigold-500 hover:text-marigold-600"
            >
              {q}
            </button>
          ))}
        </div>
      </Card>

      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          placeholder="Ask something that needs planning — prioritizing, tradeoffs, comparisons…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button type="submit" disabled={asking || !question.trim()}>
          {asking ? "Thinking…" : "Ask"}
        </Button>
      </form>
      {error && <p className="text-sm text-loss">{error}</p>}

      <div className="flex flex-wrap gap-2">
        {INTENT_FILTERS.map((f) => (
          <button
            key={f.label}
            onClick={() => setIntentFilter(f.value)}
            className={`rounded-full border px-3 py-1 text-xs ${
              intentFilter === f.value ? "border-marigold-500 bg-marigold-50 text-marigold-600" : "border-line text-ink-soft"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {!loadingHistory && filtered.length === 0 && !asking && (
          <p className="text-sm text-ink-faint">No questions in this category yet.</p>
        )}
        {filtered.map((h) => (
          <Card key={h.id} className={!h.verificationPassed ? "border-marigold-400" : undefined}>
            <div className="flex items-start justify-between gap-3">
              <p className="text-sm font-medium text-ink">{h.question}</p>
              <span className="shrink-0 rounded-sm bg-paper px-2 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
                {h.path === "DETERMINISTIC" ? h.matchedIntent : h.advancedIntent}
              </span>
            </div>
            <p className="mt-2 text-sm text-ink-soft">{h.answer}</p>

            {h.staleAdviceNote && <p className="mt-2 text-xs italic text-ink-faint">{h.staleAdviceNote}</p>}

            <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-ink-faint">
              <ConfidenceBadge value={Number(h.confidence)} />
              {!h.verificationPassed && (
                <span className="rounded-sm bg-marigold-50 px-2 py-0.5 text-[10px] uppercase tracking-wide text-marigold-600">
                  Composed answer didn&apos;t verify — showing raw facts
                </span>
              )}
              <button onClick={() => toggleExpanded(h.id)} className="underline hover:text-marigold-600">
                {expandedIds.has(h.id) ? "Hide evidence & plan" : "Show evidence & plan"}
              </button>
            </div>

            {expandedIds.has(h.id) && (
              <div className="mt-3 space-y-3 border-t border-line pt-3">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-faint">Plan</p>
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-xs text-ink-soft">
                    {h.plan.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                </div>
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-ink-faint">Evidence</p>
                  <pre className="mt-1 overflow-x-auto rounded-sm bg-paper p-2 text-[11px] text-ink-soft">
                    {JSON.stringify(h.facts, null, 2)}
                  </pre>
                </div>
                {h.citedSources.length > 0 && (
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-ink-faint">Linked sources</p>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {h.citedSources.map((id) => (
                        <span key={id} className="rounded-sm bg-paper px-2 py-0.5 text-[10px] text-ink-faint">
                          {id}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </Card>
        ))}
        <div ref={bottomRef} />
      </div>

      <p className="text-[11px] text-ink-faint">
        Advanced mode still answers only from your own data — known questions go through the same deterministic
        router as the other tab; new question types get planned, gathered, composed, and every figure in the
        composed answer is checked against the underlying facts before you see it. If that check fails, you get
        the raw facts instead of a composed sentence.
      </p>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: number }) {
  const tier = value >= 0.7 ? "text-gain" : value >= 0.4 ? "text-marigold-600" : "text-loss";
  return (
    <span>
      Confidence: <span className={`font-mono ${tier}`}>{Math.round(value * 100)}%</span>
    </span>
  );
}
