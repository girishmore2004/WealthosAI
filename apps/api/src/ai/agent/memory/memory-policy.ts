import { MemorySource, MemoryCategory } from "../agent.types";
import { MEMORY_AI_INFERRED_MAX_CONFIDENCE } from "../agent.constants";

// Pure rules for what may be remembered and how memories compete. No I/O, so every rule is unit-tested directly.

/** Higher wins a conflict. USER_CONFIRMED > SYSTEM_VERIFIED > AI_INFERRED > CONVERSATION_CONTEXT. */
export const TRUST_RANK: Record<MemorySource, number> = {
  USER_CONFIRMED: 4,
  SYSTEM_VERIFIED: 3,
  AI_INFERRED: 1,
  CONVERSATION_CONTEXT: 0,
};

const SENSITIVE_PATTERN =
  /₹|\brs\.?\s?\d|\binr\b|\d{2,}|\b(loan|emi|salary|income|debt|insurance|polic(?:y|ies)|account|net worth|savings?|balance|tax|pan|aadhaar|premium|mortgage|portfolio|sip|investment|expense)s?\b/i;

/** SENSITIVE memories are encrypted at rest. Anything with an amount or a financial term is treated as sensitive;
 * only plain preferences ("prefers short answers") stay NORMAL. */
export function classifyPrivacy(text: string): "NORMAL" | "SENSITIVE" {
  return SENSITIVE_PATTERN.test(text) ? "SENSITIVE" : "NORMAL";
}

export interface EvidenceItem {
  type: string;
  ref: string;
}

export type MemoryWriteVerdict = { ok: true; confidence: number; verification: "USER_CONFIRMED" | "SYSTEM_VERIFIED" | "UNVERIFIED" } | { ok: false; reason: string };

/** Decides whether a candidate may be stored and with what confidence / verification. The key rule: a memory can only
 * claim to be user-confirmed if the user's own message is its evidence, and only claim to be system-verified if a
 * deterministic service produced it. A model's inference is capped and stays UNVERIFIED until the user confirms it. */
export function assessMemoryWrite(c: { source: MemorySource; confidence: number; evidence: EvidenceItem[]; category: MemoryCategory }): MemoryWriteVerdict {
  const types = new Set(c.evidence.map((e) => e.type));
  switch (c.source) {
    case "USER_CONFIRMED":
      if (!types.has("user_message") && !types.has("user_approval") && !types.has("user_correction")) {
        return { ok: false, reason: "user_confirmed memory requires the user's own message as evidence" };
      }
      return { ok: true, confidence: 1, verification: "USER_CONFIRMED" };
    case "SYSTEM_VERIFIED":
      if (!types.has("tool") && !types.has("snapshot") && !types.has("execution")) {
        return { ok: false, reason: "system_verified memory requires a deterministic tool result as evidence" };
      }
      return { ok: true, confidence: Math.min(1, Math.max(0.5, c.confidence)), verification: "SYSTEM_VERIFIED" };
    case "AI_INFERRED":
      return { ok: true, confidence: Math.min(MEMORY_AI_INFERRED_MAX_CONFIDENCE, Math.max(0.1, c.confidence)), verification: "UNVERIFIED" };
    case "CONVERSATION_CONTEXT":
      return { ok: true, confidence: Math.min(0.5, Math.max(0.1, c.confidence)), verification: "UNVERIFIED" };
  }
}

export type ConflictResolution = "replace_existing" | "reject_candidate";

/** Existing memory vs a new candidate with the same subject but different content. Higher trust wins; on a tie the newer
 * statement wins (people change their minds). A model's inference can therefore never overwrite something the user
 * confirmed or the system verified. */
export function resolveConflict(existing: { source: MemorySource }, candidate: { source: MemorySource }): ConflictResolution {
  return TRUST_RANK[candidate.source] >= TRUST_RANK[existing.source] ? "replace_existing" : "reject_candidate";
}

// --- relevance --------------------------------------------------------------------------------------------

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are", "was", "were", "be", "i", "my", "me", "we", "our", "it", "this", "that", "with", "do", "does", "did", "what", "how", "can", "will", "about", "have", "has", "had", "you", "your"]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}₹]+/gu) ?? []).filter((t) => t.length > 1 && !STOP.has(t));
}

/** Share of the query's meaningful tokens present in the memory (0-1). */
export function lexicalOverlap(query: string, memoryText: string): number {
  const q = new Set(tokenize(query));
  if (q.size === 0) return 0;
  const m = new Set(tokenize(memoryText));
  let hit = 0;
  for (const t of q) if (m.has(t)) hit += 1;
  return hit / q.size;
}

export function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

export interface ScoreInput {
  semantic: number;
  lexical: number;
  source: MemorySource;
  confidence: number;
  ageDays: number;
  category: MemoryCategory;
  intent: string;
}

const CATEGORY_BOOST: Record<string, Partial<Record<MemoryCategory, number>>> = {
  memory_recall: { EPISODIC: 1, GOAL: 0.8, SEMANTIC: 0.6, PROCEDURAL: 0.3 },
  planning: { GOAL: 1, SEMANTIC: 0.8, PROCEDURAL: 0.5, EPISODIC: 0.4 },
  scenario_analysis: { SEMANTIC: 1, GOAL: 0.8, EPISODIC: 0.3, PROCEDURAL: 0.2 },
  financial_analysis: { SEMANTIC: 0.8, GOAL: 0.6, PROCEDURAL: 0.5, EPISODIC: 0.4 },
  action_request: { PROCEDURAL: 1, SEMANTIC: 0.7, GOAL: 0.7, EPISODIC: 0.2 },
};

/** Relevance (what the memory is about) dominates; trust, recency and category fit break ties. Returned together with the
 * relevance on its own so the caller can drop memories that merely look trustworthy but are about something else. */
export function scoreMemory(s: ScoreInput): { relevance: number; score: number } {
  // Without a usable vector (embedding service down, or older embedding version) lexical overlap is the only signal, so it
  // carries the full weight instead of being capped at 0.35 and never clearing the relevance threshold.
  const relevance = s.semantic > 0 ? Math.min(1, 0.65 * s.semantic + 0.35 * s.lexical) : Math.min(1, s.lexical);
  const trust = (TRUST_RANK[s.source] / 4) * s.confidence;
  const recency = Math.exp(-Math.max(0, s.ageDays) / 180);
  const boost = CATEGORY_BOOST[s.intent]?.[s.category] ?? 0.4;
  return { relevance, score: 0.6 * relevance + 0.2 * trust + 0.1 * recency + 0.1 * boost };
}
