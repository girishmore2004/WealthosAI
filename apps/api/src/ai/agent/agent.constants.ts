// Limits and tunables for the unified agent. Every value that bounds work (steps, time, size) lives here so
// the guarantees in the README ("the agent cannot loop or run unbounded") are checkable in one place.

/** LangGraph recursion limit: hard ceiling on graph super-steps for ONE invocation. The graph has no cycle
 * except the single bounded retry edge, so a normal run uses ~12 steps; 30 leaves headroom for one retry
 * and a resume, and anything beyond it is a bug that must stop rather than run on. */
export const AGENT_RECURSION_LIMIT = 30;

/** Maximum tool calls planned for one request. The planner emits at most 3 today; the cap is enforced again at
 * execution so no future planner change can fan out unbounded work. */
export const AGENT_MAX_TOOL_CALLS = 4;

/** A failed tool call is retried at most this many times (only when the failure is classified transient). */
export const AGENT_MAX_TOOL_RETRIES = 1;

/** Per-tool wall-clock budget. Tools that call a model (RAG, coach, scenario studio) take longer than reads. */
export const AGENT_TOOL_TIMEOUT_MS = 25_000;
export const AGENT_SLOW_TOOL_TIMEOUT_MS = 45_000;

/** Whole-request wall-clock budget (graph execution; an approval wait is NOT counted — it is a separate request). */
export const AGENT_RUN_TIMEOUT_MS = 90_000;

/** How long a pending approval can be decided before it expires. */
export const AGENT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Input bounds. */
export const AGENT_MAX_MESSAGE_CHARS = 2000;
export const AGENT_MAX_ATTACHMENTS = 5;

/** Short-term conversation context handed to intent understanding: only the last few turns, truncated. The
 * full transcript is never sent to a model. */
export const AGENT_CONTEXT_TURNS = 4;
export const AGENT_CONTEXT_TURN_CHARS = 280;

/** Memory retrieval. */
export const MEMORY_RETRIEVE_TOP_K = 6;
export const MEMORY_CANDIDATE_POOL = 300;
export const MEMORY_MIN_RELEVANCE = 0.18;
export const MEMORY_MAX_CONTENT_CHARS = 600;
/** AI-inferred memories never exceed this confidence, so they can never outrank a user-confirmed fact. */
export const MEMORY_AI_INFERRED_MAX_CONFIDENCE = 0.6;
/** Temporary conversation context expires quickly; episodic notes are reviewed rather than kept forever. */
export const MEMORY_CONTEXT_TTL_DAYS = 2;
export const MEMORY_EPISODIC_TTL_DAYS = 365;
export const MEMORY_EPISODIC_DIGEST_AFTER_DAYS = 60;

/** Name of the BullMQ job (through the existing AI queue) that consolidates memory after a conversation. */
export const MEMORY_CONSOLIDATION_JOB = "agent.memory_consolidation";
