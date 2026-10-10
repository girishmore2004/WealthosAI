"use client";

import { useEffect, useRef, useState } from "react";

// A tiny in-app event bus so every financial widget refreshes when money moves, without the
// user reloading the browser. Anything that writes financial data (quick expense, receivable
// repayment, investment contribution, emergency-fund entry …) calls emitFinancialChange(); any
// widget that shows derived numbers (page summaries, dashboard cards, reports) subscribes with
// useFinancialVersion() and refetches when it changes. The server stays the source of truth:
// the bus carries no numbers, only "something changed, ask again".

export type FinancialChange = "expense" | "income" | "investment" | "emergency" | "receivable" | "transfer";

type Listener = (kind: FinancialChange) => void;

const listeners = new Set<Listener>();

export function emitFinancialChange(kind: FinancialChange): void {
  // Copy first so a listener that unsubscribes while handling an event can't skip a sibling.
  for (const l of Array.from(listeners)) {
    try {
      l(kind);
    } catch {
      // One misbehaving widget must never stop the others from refreshing.
    }
  }
}

export function onFinancialChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runs `handler` whenever one of `kinds` (default: any) changes. */
export function useFinancialChange(handler: Listener, kinds?: FinancialChange[]): void {
  const latest = useRef(handler);
  latest.current = handler;
  const kindsKey = kinds ? kinds.join(",") : "*";
  useEffect(
    () =>
      onFinancialChange((kind) => {
        if (!kinds || kinds.includes(kind)) latest.current(kind);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kindsKey],
  );
}

/** A counter that increments on every relevant change — put it in a data-loading effect's deps. */
export function useFinancialVersion(kinds?: FinancialChange[]): number {
  const [version, setVersion] = useState(0);
  useFinancialChange(() => setVersion((v) => v + 1), kinds);
  return version;
}
