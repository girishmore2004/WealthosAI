
"use client";

import {
  FormEvent,
  KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { api, ApiError } from "@/lib/api-client";

import type {
  AgentResponseDTO,
  AgentApprovalDTO,
} from "@/lib/api-client";

import type {
  CategoryDTO,
  IngestionBatchDTO,
  IngestionBatchSummaryDTO,
  IngestionReviewItemDTO,
  PaymentMethod,
} from "@wealthos/types";

import { formatINR } from "@/lib/format";
import { AgentMarkdown } from "@/components/ai/agent-markdown";
type ConversationSummary = {
  id: string;
  title: string;
  status: string;
  lastMessageAt: string;
};

type StoredMessage = {
  id: string;
  role: string;
  content: string;
  payload?: unknown;
  createdAt: string;
};

type AgentTurn = {
  id: string;
  role: "USER" | "ASSISTANT";
  content: string;
  createdAt?: string;
  result?: AgentResponseDTO;
};

const SUGGESTIONS = [
  {
    title: "Understand my finances",
    prompt:
      "Analyze my current financial position, income, expenses, savings, investments and liabilities. Highlight the most important findings.",
  },
  {
    title: "Find spending patterns",
    prompt:
      "Analyze my recent spending, identify unusual expenses and suggest practical ways to improve my monthly savings.",
  },
  {
    title: "Plan a financial goal",
    prompt:
      "Review my financial position and help me create a realistic plan for my most important financial goal.",
  },
  {
    title: "Run a what-if scenario",
    prompt:
      "What happens to my finances if my monthly salary increases by 15%? Compare the impact on savings and goals.",
  },
  {
    title: "Search my documents",
    prompt:
      "Search my uploaded financial documents for important information about my accounts, loans, insurance and investments. Cite the sources you find.",
  },
  {
    title: "Review my statements",
    prompt:
      "Check the status of my uploaded bank statements and tell me whether any transactions need review.",
  },
];

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;

  return "The AI Agent could not complete this request. Please try again.";
}

function resultFromStoredMessage(
  message: StoredMessage
): AgentResponseDTO | undefined {
  if (!message.payload || typeof message.payload !== "object") {
    return undefined;
  }

  const payload = message.payload as Partial<AgentResponseDTO>;

  if (!payload.intent && !payload.answerType && !payload.approvals) {
    return undefined;
  }

  return {
    ...payload,
    response: message.content,
    messageId: message.id,
  } as AgentResponseDTO;
}

function formatDate(value?: string): string {
  if (!value) return "";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) return "";

  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function AiAgentPage() {
  const [conversations, setConversations] = useState<
    ConversationSummary[]
  >([]);

  const [conversationId, setConversationId] = useState<
    string | undefined
  >();

  const [turns, setTurns] = useState<AgentTurn[]>([]);
  const [message, setMessage] = useState("");

  const [loadingHistory, setLoadingHistory] = useState(true);
  const [loadingConversation, setLoadingConversation] = useState(false);
  const [sending, setSending] = useState(false);

  const [busyApproval, setBusyApproval] = useState<string | null>(
    null
  );

  const [error, setError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const [reindexing, setReindexing] = useState(false);
  const [reindexNotice, setReindexNotice] = useState<string | null>(
    null
  );

  const [showDetails, setShowDetails] = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const refreshConversations = useCallback(async () => {
    try {
      const items = await api.agent.conversations();
      setConversations(items);
    } catch {
      // Chat remains usable if history cannot be loaded.
    }
  }, []);

  useEffect(() => {
    let active = true;

    api.agent
      .conversations()
      .then((items) => {
        if (active) setConversations(items);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      })
      .finally(() => {
        if (active) setLoadingHistory(false);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "end",
    });
  }, [turns, sending]);

  const startNewConversation = () => {
    setConversationId(undefined);
    setTurns([]);
    setMessage("");
    setError(null);
    setHistoryOpen(false);
    inputRef.current?.focus();
  };

  const openConversation = async (id: string) => {
    setLoadingConversation(true);
    setError(null);

    try {
      const messages = (await api.agent.messages(
        id
      )) as StoredMessage[];

      setConversationId(id);

      setTurns(
        messages.map((item) => ({
          id: item.id,
          role: item.role === "USER" ? "USER" : "ASSISTANT",
          content: item.content,
          createdAt: item.createdAt,
          result: resultFromStoredMessage(item),
        }))
      );

      setHistoryOpen(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingConversation(false);
    }
  };

  const sendMessage = async (rawMessage: string) => {
    const text = rawMessage.trim();

    if (!text || sending) return;

    setError(null);
    setSending(true);
    setMessage("");

    setTurns((current) => [
      ...current,
      {
        id: `local-user-${Date.now()}`,
        role: "USER",
        content: text,
        createdAt: new Date().toISOString(),
      },
    ]);

    try {
      const result = await api.agent.chat(text, {
        conversationId,
      });

      setConversationId(result.conversationId);

      setTurns((current) => [
        ...current,
        {
          id: result.messageId,
          role: "ASSISTANT",
          content: result.response,
          createdAt: new Date().toISOString(),
          result,
        },
      ]);

      await refreshConversations();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendMessage(message);
  };

  const handleInputKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>
  ) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();

      if (message.trim()) {
        void sendMessage(message);
      }
    }
  };

  const decide = async (
    approval: AgentApprovalDTO,
    decision: "approve" | "reject"
  ) => {
    if (busyApproval) return;

    setBusyApproval(approval.approvalId);
    setError(null);

    try {
      const result = await api.agent.decide(
        approval.approvalId,
        decision
      );

      setTurns((current) => [
        ...current,
        {
          id: result.messageId,
          role: "ASSISTANT",
          content: result.response,
          createdAt: new Date().toISOString(),
          result,
        },
      ]);

      await refreshConversations();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusyApproval(null);
    }
  };

  const hasTurns = turns.length > 0;

  return (
    <div className="mx-auto flex min-h-[calc(100vh-8rem)] max-w-6xl flex-col gap-5">

      {/* HEADER */}

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-marigold-500 text-onaccent">
            <SparkleIcon />
          </span>

          <div>
            <h1 className="font-display text-2xl text-ink sm:text-3xl">
              WealthOS AI Agent
            </h1>

            <p className="text-sm text-ink-soft">
              One assistant for your complete financial life.
            </p>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setShowImport((open) => !open)}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-soft hover:bg-surface-muted"
            aria-expanded={showImport}
          >
            {showImport ? "Close import" : "Import statement"}
          </button>

          <button
            type="button"
            onClick={() => setHistoryOpen((open) => !open)}
            className="rounded-lg border border-line px-3 py-2 text-sm text-ink-soft hover:bg-surface-muted"
            aria-expanded={historyOpen}
          >
            {historyOpen ? "Close history" : "History"}
          </button>

          <button
            type="button"
            onClick={startNewConversation}
            disabled={sending}
            className="rounded-lg bg-ink px-3 py-2 text-sm font-medium text-paper hover:opacity-90 disabled:opacity-50"
          >
            New chat
          </button>
        </div>
      </header>

      {/* CONVERSATION HISTORY */}

      {historyOpen && (
        <section className="panel p-4" aria-label="Conversation history">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium text-ink">
              Recent conversations
            </h2>

            {loadingHistory && (
              <span className="text-xs text-ink-faint">
                Loading…
              </span>
            )}
          </div>

          {conversations.length === 0 ? (
            <p className="text-sm text-ink-faint">
              Your conversations will appear here.
            </p>
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2">
              {conversations.map((conversation) => (
                <li key={conversation.id}>
                  <button
                    type="button"
                    onClick={() => void openConversation(conversation.id)}
                    disabled={loadingConversation || sending}
                    className={`w-full rounded-lg border p-3 text-left transition-colors hover:border-marigold-500 hover:bg-surface-muted ${
                      conversation.id === conversationId
                        ? "border-marigold-500 bg-surface-muted"
                        : "border-line"
                    }`}
                  >
                    <span className="block truncate text-sm font-medium text-ink">
                      {conversation.title || "New conversation"}
                    </span>

                    <span className="mt-1 block text-xs text-ink-faint">
                      {formatDate(conversation.lastMessageAt)} ·{" "}
                      {conversation.status.toLowerCase().replaceAll("_", " ")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* COPILOT IMPORT INSIDE THE SAME AGENT PAGE */}

      {showImport && (
        <StatementImportWorkspace
          onClose={() => setShowImport(false)}
        />
      )}

      {/* MAIN CHAT */}

      <section className="grid min-h-[560px] flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">

        <div className="flex min-h-[560px] min-w-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-card">

          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-gain" />

              <span className="text-sm font-medium text-ink">
                Financial Agent
              </span>

              <span className="text-xs text-ink-faint">
                · Private session
              </span>
            </div>

            <button
              type="button"
              onClick={() => setShowDetails((show) => !show)}
              className="text-xs text-ink-faint hover:text-ink lg:hidden"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
          </div>

          <div
            className="flex-1 space-y-5 overflow-y-auto p-4 sm:p-6"
            aria-live="polite"
          >
            {loadingConversation && (
              <p className="text-center text-sm text-ink-faint">
                Loading conversation…
              </p>
            )}

            {!hasTurns && !loadingConversation && (
              <div className="mx-auto max-w-2xl py-8">
                <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-marigold-50 text-marigold-600">
                  <SparkleIcon large />
                </div>

                <h2 className="text-center font-display text-2xl text-ink">
                  What would you like to work on?
                </h2>

                <p className="mx-auto mt-2 max-w-lg text-center text-sm leading-6 text-ink-soft">
                  Ask questions about your money, search your records,
                  review documents, plan goals, compare scenarios or
                  request an action. I will choose the relevant
                  available tools.
                </p>

                <div className="mt-7 grid gap-2 sm:grid-cols-2">
                  {SUGGESTIONS.map((item) => (
                    <button
                      key={item.title}
                      type="button"
                      onClick={() => void sendMessage(item.prompt)}
                      disabled={sending}
                      className="rounded-xl border border-line p-3 text-left transition-colors hover:border-marigold-500 hover:bg-surface-muted disabled:opacity-50"
                    >
                      <span className="block text-sm font-medium text-ink">
                        {item.title}
                      </span>

                      <span className="mt-1 block text-xs leading-5 text-ink-faint">
                        {item.prompt}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {turns.map((turn) => (
              <article
                key={turn.id}
                className={`flex ${
                  turn.role === "USER"
                    ? "justify-end"
                    : "justify-start"
                }`}
              >
                <div
                  className={`max-w-[92%] min-w-0 sm:max-w-[85%] ${
                    turn.role === "USER"
                      ? "rounded-2xl rounded-br-sm bg-marigold-50 px-4 py-3 text-ink"
                      : "w-full rounded-2xl rounded-bl-sm border border-line bg-paper px-4 py-4 text-ink"
                  }`}
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
                      {turn.role === "USER" ? "You" : "WealthOS AI"}
                    </span>

                    <span className="text-[10px] text-ink-faint">
                      {formatDate(turn.createdAt)}
                    </span>
                  </div>

                  {turn.role === "ASSISTANT" ? (
                    <AgentMarkdown text={turn.content} />
                  ) : (
                    <div className="whitespace-pre-wrap break-words text-sm leading-6">
                      {turn.content}
                    </div>
                  )}

                  {turn.role === "ASSISTANT" && turn.result && (
                    <AgentResultDetails
                      result={turn.result}
                      onDecision={decide}
                      busyApproval={busyApproval}
                    />
                  )}
                </div>
              </article>
            ))}

            {sending && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-line bg-paper px-4 py-3 text-sm text-ink-soft">
                  <span className="inline-flex items-center gap-2">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-marigold-500" />
                    Reviewing your financial context and selecting tools…
                  </span>
                </div>
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {error && (
            <div
              role="alert"
              className="mx-4 mb-2 rounded-lg border border-loss/30 bg-loss/5 p-3 text-sm text-loss"
            >
              {error}

              <button
                type="button"
                onClick={() => setError(null)}
                className="ml-2 underline"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* MESSAGE COMPOSER */}

          <form
            onSubmit={submit}
            className="border-t border-line bg-paper p-3 sm:p-4"
          >
            <label htmlFor="agent-message" className="sr-only">
              Message your WealthOS AI Agent
            </label>

            <div className="flex items-end gap-2 rounded-xl border border-line bg-surface p-2 focus-within:border-marigold-500">
              <textarea
                ref={inputRef}
                id="agent-message"
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={handleInputKeyDown}
                maxLength={2000}
                rows={2}
                placeholder="Ask anything about your finances…"
                disabled={sending}
                className="max-h-40 min-h-[48px] flex-1 resize-y bg-transparent px-2 py-2 text-sm text-ink outline-none placeholder:text-ink-faint disabled:opacity-60"
              />

              <button
                type="submit"
                disabled={sending || !message.trim()}
                className="rounded-lg bg-marigold-500 px-4 py-2.5 text-sm font-semibold text-onaccent transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? "Working…" : "Send"}
              </button>
            </div>

            <p className="mt-2 px-1 text-[11px] text-ink-faint">
              Enter to send · Shift + Enter for a new line · Never share
              passwords, full card numbers or API keys.
            </p>
          </form>
        </div>

        {/* AGENT CAPABILITIES */}

        <aside
          className={`${showDetails ? "block" : "hidden"} space-y-3 lg:block`}
          aria-label="Agent capabilities and safeguards"
        >
          <div className="panel p-4">
            <h2 className="text-sm font-semibold text-ink">
              One agent. All your finances.
            </h2>

            <p className="mt-1 text-xs leading-5 text-ink-soft">
              The agent selects from the tools enabled in your account.
              You do not need to switch between separate AI sections.
            </p>

            <ul className="mt-3 space-y-2 text-xs text-ink-soft">
              <Capability label="Financial analysis" />
              <Capability label="Document and record search" />
              <Capability label="Goal and plan assistance" />
              <Capability label="What-if simulations" />
              <Capability label="Spending and ML insights" />
              <Capability label="Statement processing status" />
              <Capability label="Tasks and approved actions" />
              <Capability label="Personalized memory" />
            </ul>
          </div>

          <div className="panel p-4">
            <h2 className="text-sm font-semibold text-ink">
              Search index
            </h2>

            <p className="mt-1 text-xs leading-5 text-ink-soft">
              Refresh the searchable index after adding or changing
              documents and financial records.
            </p>

            <button
              type="button"
              onClick={async () => {
                setReindexing(true);
                setReindexNotice(null);

                try {
                  const job = await api.aiSearch.reindex();

                  setReindexNotice(
                    job.status === "DONE"
                      ? "Your search index is already up to date."
                      : job.reused
                        ? "A refresh is already running."
                        : `Search index refresh started (${job.status.toLowerCase()}).`
                  );
                } catch (err) {
                  setReindexNotice(errorMessage(err));
                } finally {
                  setReindexing(false);
                }
              }}
              disabled={reindexing}
              className="mt-3 rounded-lg border border-line px-3 py-2 text-xs font-medium text-ink-soft hover:bg-surface-muted disabled:opacity-50"
            >
              {reindexing ? "Starting refresh…" : "Refresh search index"}
            </button>

            {reindexNotice && (
              <p role="status" className="mt-2 text-xs text-ink-faint">
                {reindexNotice}
              </p>
            )}
          </div>

          <div className="panel p-4">
            <h2 className="text-sm font-semibold text-ink">
              Safety and accuracy
            </h2>

            <ul className="mt-2 space-y-2 text-xs leading-5 text-ink-soft">
              <li>• Financial calculations use deterministic services where available.</li>
              <li>• Document answers can include evidence and source references.</li>
              <li>• Actions requiring approval wait for your decision.</li>
              <li>• The agent may ask a question when required information is missing.</li>
            </ul>
          </div>

          <p className="px-1 text-[11px] leading-5 text-ink-faint">
            AI output can be incomplete. Review financial decisions and
            proposed actions before proceeding.
          </p>
        </aside>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Agent response details                                                     */
/* -------------------------------------------------------------------------- */

function AgentResultDetails({
  result,
  onDecision,
  busyApproval,
}: {
  result: AgentResponseDTO;
  onDecision: (
    approval: AgentApprovalDTO,
    decision: "approve" | "reject"
  ) => Promise<void>;
  busyApproval: string | null;
}) {
  const approvals = result.approvals ?? [];
  const pendingApprovals = approvals.filter(
    (approval) => approval.status === "PENDING"
  );

  const evidence = result.evidence ?? [];
  const warnings = result.warnings ?? [];
  const followUps = result.followUps ?? [];

  const calculations = (result.calculations ?? []) as {
    label: string;
    value: string;
    method: string;
    source: string;
  }[];

  const sections = result.sections;

  return (
    <div className="mt-4 space-y-3 border-t border-line pt-3">

      {result.execution?.toolCalls?.length > 0 && (
        <details className="rounded-lg bg-surface-muted p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink">
            Work performed ({result.execution.toolCalls.length})
          </summary>

          <ul className="mt-2 space-y-1 text-xs text-ink-soft">
            {result.execution.toolCalls.map((call, index) => (
              <li key={`${call.tool}-${index}`}>
                {call.tool.replaceAll("_", " ")} · {call.status}
              </li>
            ))}
          </ul>
        </details>
      )}

      {evidence.length > 0 && (
        <details className="rounded-lg bg-surface-muted p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink">
            Evidence and sources ({evidence.length})
          </summary>

          <ul className="mt-2 space-y-2">
            {evidence.map((item, index) => (
              <li
                key={`${item.source}-${index}`}
                className="text-xs text-ink-soft"
              >
                <span className="font-medium text-ink">
                  {item.label}
                </span>{" "}
                · {item.source}

                {item.detail && (
                  <p className="mt-0.5">{item.detail}</p>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}

      {sections && (
        <details className="rounded-lg bg-surface-muted p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink">
            Answer breakdown
          </summary>

          <div className="mt-2 space-y-2 text-xs text-ink-soft">
            {([
              ["Verified facts", sections.verifiedFacts],
              ["Document evidence", sections.documentEvidence],
              ["Earlier context", sections.historicalMemory],
              ["Assumptions", sections.assumptions],
              ["Recommendations", sections.recommendations],
            ] as [string, string[]][]).map(([heading, lines]) =>
              lines.length > 0 ? (
                <div key={heading}>
                  <p className="font-semibold text-ink">{heading}</p>

                  <ul className="mt-1 list-disc space-y-1 pl-4">
                    {lines.map((line, index) => (
                      <li key={index}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null
            )}
          </div>
        </details>
      )}

      {calculations.length > 0 && (
        <details className="rounded-lg bg-surface-muted p-3">
          <summary className="cursor-pointer text-xs font-semibold text-ink">
            Calculations ({calculations.length})
          </summary>

          <ul className="mt-2 space-y-2">
            {calculations.map((item, index) => (
              <li
                key={`${item.label}-${index}`}
                className="text-xs text-ink-soft"
              >
                <span className="font-medium text-ink">
                  {item.label}: {item.value}
                </span>

                <p>{item.method} · {item.source}</p>
              </li>
            ))}
          </ul>
        </details>
      )}

      {pendingApprovals.map((approval) => (
        <div
          key={approval.approvalId}
          className="rounded-xl border border-marigold-500/50 bg-marigold-50/50 p-3"
        >
          <p className="text-xs font-semibold text-ink">
            Your approval is required
          </p>

          <p className="mt-1 text-sm text-ink">
            {approval.summary}
          </p>

          <p className="mt-1 text-[11px] text-ink-faint">
            Tool: {approval.tool.replaceAll("_", " ")} · Risk:{" "}
            {approval.risk}
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void onDecision(approval, "approve")}
              disabled={busyApproval !== null}
              className="rounded-lg bg-ink px-3 py-2 text-xs font-semibold text-paper disabled:opacity-50"
            >
              {busyApproval === approval.approvalId
                ? "Processing…"
                : "Approve"}
            </button>

            <button
              type="button"
              onClick={() => void onDecision(approval, "reject")}
              disabled={busyApproval !== null}
              className="rounded-lg border border-line px-3 py-2 text-xs text-ink-soft disabled:opacity-50"
            >
              Reject
            </button>
          </div>
        </div>
      ))}

      {approvals
        .filter((approval) => approval.status !== "PENDING")
        .map((approval) => (
          <p
            key={approval.approvalId}
            className="text-xs text-ink-faint"
          >
            Approval {approval.status.toLowerCase()}: {approval.summary}
          </p>
        ))}

      {warnings.length > 0 && (
        <div className="rounded-lg border border-marigold-500/30 bg-marigold-50/40 p-3">
          <p className="text-xs font-semibold text-ink">
            Important notes
          </p>

          <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-ink-soft">
            {warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {result.verification && !result.verification.passed && (
        <p className="rounded-lg border border-loss/30 bg-loss/5 p-3 text-xs text-loss">
          Some answer checks did not pass. Review the answer and its
          evidence carefully.
        </p>
      )}

      {followUps.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {followUps.slice(0, 4).map((followUp, index) => (
            <span
              key={`${followUp}-${index}`}
              className="rounded-full border border-line px-2.5 py-1 text-[11px] text-ink-faint"
            >
              {followUp}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function Capability({ label }: { label: string }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-gain" />
      <span>{label}</span>
    </li>
  );
}

function SparkleIcon({ large = false }: { large?: boolean }) {
  const size = large ? 28 : 20;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m12 3 1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z" />
      <path d="m19 15 .9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* Copilot statement import and transaction review                            */
/* -------------------------------------------------------------------------- */

function StatementImportWorkspace({
  onClose,
}: {
  onClose: () => void;
}) {
  const [sourceLabel, setSourceLabel] = useState("");
  const [rawText, setRawText] = useState("");
  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>("CARD");

  const [categories, setCategories] = useState<CategoryDTO[]>([]);
  const [batches, setBatches] = useState<
    IngestionBatchSummaryDTO[]
  >([]);

  const [activeBatch, setActiveBatch] =
    useState<IngestionBatchDTO | null>(null);

  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    Promise.all([
      api.expenses.categories(),
      api.copilotIngestion.listBatches(),
    ])
      .then(([categoryRows, batchRows]) => {
        if (!active) return;

        setCategories(categoryRows);
        setBatches(batchRows);
      })
      .catch((err) => {
        if (active) setError(errorMessage(err));
      });

    return () => {
      active = false;
    };
  }, []);

  const refreshBatches = async () => {
    try {
      setBatches(await api.copilotIngestion.listBatches());
    } catch {
      // Keep the current batch visible.
    }
  };

  const loadBatch = async (id: string) => {
    setError(null);

    try {
      setActiveBatch(
        await api.copilotIngestion.getBatch(id)
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const createBatch = async (
    event: FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();

    if (
      !sourceLabel.trim() ||
      rawText.trim().length < 10 ||
      creating
    ) {
      return;
    }

    setCreating(true);
    setError(null);

    try {
      const batch = await api.copilotIngestion.createBatch(
        sourceLabel.trim(),
        rawText,
        paymentMethod
      );

      setActiveBatch(batch);
      setRawText("");

      await refreshBatches();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setCreating(false);
    }
  };

  const updateItem = (updated: IngestionReviewItemDTO) => {
    setActiveBatch((current) =>
      current
        ? {
            ...current,
            items: current.items.map((item) =>
              item.id === updated.id ? updated : item
            ),
          }
        : current
    );

    void refreshBatches();
  };

  return (
    <section
      className="panel space-y-4 p-4 sm:p-5"
      aria-label="Statement import and review"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl text-ink">
            Import a statement
          </h2>

          <p className="mt-1 max-w-2xl text-sm text-ink-soft">
            Paste bank or card statement text. Copilot extracts
            transaction suggestions, flags possible duplicates and
            unusual amounts, and stages them for your review. Nothing
            enters your expense ledger until you approve it.
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-line px-3 py-2 text-xs text-ink-soft hover:bg-surface-muted"
        >
          Close
        </button>
      </div>

      <form onSubmit={createBatch} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-[1fr_220px]">
          <input
            value={sourceLabel}
            onChange={(event) => setSourceLabel(event.target.value)}
            maxLength={120}
            required
            placeholder="Statement label, e.g. HDFC October 2026"
            className="min-w-0 rounded-lg border border-line bg-paper px-3 py-2.5 text-sm text-ink outline-none focus:border-marigold-500"
          />

          <select
            value={paymentMethod}
            onChange={(event) =>
              setPaymentMethod(event.target.value as PaymentMethod)
            }
            className="rounded-lg border border-line bg-paper px-3 py-2.5 text-sm text-ink"
          >
            {(
              [
                "UPI",
                "CARD",
                "CASH",
                "BANK_TRANSFER",
                "WALLET",
                "OTHER",
              ] as PaymentMethod[]
            ).map((method) => (
              <option key={method} value={method}>
                {method.replaceAll("_", " ")}
              </option>
            ))}
          </select>
        </div>

        <textarea
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          minLength={10}
          maxLength={20000}
          rows={6}
          placeholder={
            "Paste statement lines here, for example:\n15/10/2026, POS AMAZON, 1249.00 Dr\n16/10/2026, UPI-SWIGGY, 350.50 Dr"
          }
          className="w-full rounded-lg border border-line bg-paper p-3 font-mono text-xs text-ink outline-none focus:border-marigold-500"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] text-ink-faint">
            10–20,000 characters · Text import only
          </p>

          <button
            type="submit"
            disabled={
              creating ||
              !sourceLabel.trim() ||
              rawText.trim().length < 10
            }
            className="rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-paper disabled:opacity-40"
          >
            {creating ? "Processing statement…" : "Process statement"}
          </button>
        </div>
      </form>

      {error && (
        <p
          role="alert"
          className="rounded-lg border border-loss/30 bg-loss/5 p-3 text-sm text-loss"
        >
          {error}
        </p>
      )}

      <div className="border-t border-line pt-4">
        <h3 className="text-sm font-semibold text-ink">
          Previous imports
        </h3>

        {batches.length === 0 ? (
          <p className="mt-2 text-xs text-ink-faint">
            No statement imports found.
          </p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {batches.map((batch) => (
              <button
                key={batch.id}
                type="button"
                onClick={() => void loadBatch(batch.id)}
                className={`rounded-lg border px-3 py-2 text-left text-xs hover:border-marigold-500 ${
                  activeBatch?.id === batch.id
                    ? "border-marigold-500 bg-surface-muted"
                    : "border-line"
                }`}
              >
                <span className="block font-medium text-ink">
                  {batch.sourceLabel}
                </span>

                <span className="mt-0.5 block text-ink-faint">
                  {batch.parsedCount} parsed · {batch.unparsedCount}{" "}
                  unparsed · {batch._count.items} review items
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {activeBatch && (
        <div className="space-y-3 border-t border-line pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-ink">
                {activeBatch.sourceLabel}
              </h3>

              <p className="text-xs text-ink-faint">
                {activeBatch.parsedCount} parsed ·{" "}
                {activeBatch.unparsedCount} unparsed
              </p>
            </div>

            <span className="rounded-full bg-surface-muted px-2.5 py-1 text-[11px] text-ink-soft">
              {
                activeBatch.items.filter(
                  (item) => item.status === "PENDING"
                ).length
              }{" "}
              awaiting review
            </span>
          </div>

          {activeBatch.items.length === 0 ? (
            <p className="text-sm text-ink-faint">
              No transaction lines were parsed.
            </p>
          ) : (
            activeBatch.items.map((item) => (
              <StatementReviewItem
                key={item.id}
                item={item}
                categories={categories}
                onResolved={updateItem}
              />
            ))
          )}
        </div>
      )}
    </section>
  );
}

function StatementReviewItem({
  item,
  categories,
  onResolved,
}: {
  item: IngestionReviewItemDTO;
  categories: CategoryDTO[];
  onResolved: (item: IngestionReviewItemDTO) => void;
}) {
  const [categoryId, setCategoryId] = useState(
    item.suggestedCategoryId ?? ""
  );

  const [duplicateResolution, setDuplicateResolution] =
    useState<
      "" | "kept_both" | "skipped_duplicate" | "merged"
    >("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const confidence = Number(item.overallConfidence);

  const approve = async () => {
    if (
      !categoryId ||
      (item.isDuplicateCandidate && !duplicateResolution) ||
      busy
    ) {
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const updated = await api.copilotIngestion.approve(
        item.id,
        {
          categoryId,
          ...(item.isDuplicateCandidate
            ? {
                duplicateResolution:
                  duplicateResolution as
                    | "kept_both"
                    | "skipped_duplicate"
                    | "merged",
              }
            : {}),
        }
      );

      onResolved(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const reject = async () => {
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const updated = await api.copilotIngestion.reject(item.id);
      onResolved(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (item.status !== "PENDING") {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-xs">
        <span className="font-medium text-ink">
          {item.merchantNormalized}
        </span>

        <span
          className={
            item.status === "APPROVED"
              ? "text-gain"
              : "text-ink-faint"
          }
        >
          {item.status.toLowerCase()}
        </span>
      </div>
    );
  }

  return (
    <article className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">
            {item.merchantNormalized || item.merchantRaw}
          </p>

          <p className="mt-0.5 text-xs text-ink-faint">
            {new Date(item.parsedDate).toLocaleDateString()} ·{" "}
            {formatINR(Number(item.parsedAmount))}
          </p>
        </div>

        <span
          className={`text-xs font-mono ${
            confidence >= 0.7
              ? "text-gain"
              : confidence >= 0.4
                ? "text-marigold-600"
                : "text-loss"
          }`}
        >
          {Math.round(confidence * 100)}% confidence
        </span>
      </div>

      <p className="mt-2 text-xs leading-5 text-ink-soft">
        {item.rationale}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {item.isDuplicateCandidate && (
          <span className="rounded bg-marigold-50 px-2 py-1 text-[10px] text-marigold-600">
            Possible duplicate
          </span>
        )}

        {item.isAnomalyCandidate && (
          <span className="rounded bg-marigold-50 px-2 py-1 text-[10px] text-marigold-600">
            Unusual amount
          </span>
        )}

        {item.isRecurringCandidate && (
          <span className="rounded bg-surface-muted px-2 py-1 text-[10px] text-ink-faint">
            Possible recurring payment
          </span>
        )}

        {item.missingFields.map((field) => (
          <span
            key={field}
            className="rounded bg-surface-muted px-2 py-1 text-[10px] text-ink-faint"
          >
            Missing: {field}
          </span>
        ))}
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <select
          value={categoryId}
          onChange={(event) => setCategoryId(event.target.value)}
          className="rounded-lg border border-line bg-paper px-2.5 py-2 text-xs text-ink"
        >
          <option value="">Select expense category</option>

          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>

        {item.isDuplicateCandidate && (
          <select
            value={duplicateResolution}
            onChange={(event) =>
              setDuplicateResolution(
                event.target.value as typeof duplicateResolution
              )
            }
            className="rounded-lg border border-line bg-paper px-2.5 py-2 text-xs text-ink"
          >
            <option value="">Resolve possible duplicate…</option>
            <option value="kept_both">Keep both transactions</option>
            <option value="skipped_duplicate">Skip as duplicate</option>
            <option value="merged">Merge into existing expense</option>
          </select>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-loss">
          {error}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={
            busy ||
            !categoryId ||
            (item.isDuplicateCandidate && !duplicateResolution)
          }
          className="rounded-lg bg-ink px-3 py-2 text-xs font-semibold text-paper disabled:opacity-40"
        >
          {busy ? "Saving…" : "Approve transaction"}
        </button>

        <button
          type="button"
          onClick={() => void reject()}
          disabled={busy}
          className="rounded-lg border border-line px-3 py-2 text-xs text-ink-soft disabled:opacity-40"
        >
          Reject
        </button>
      </div>
    </article>
  );
}
