// Deterministic prefixes/suffixes bank and card statements commonly prepend to a
// merchant string — stripped before anything is shown to a human or sent to the
// model for further cleanup. Real, testable regex rules, not a model guess for the
// part of "normalization" that's actually mechanical.
export const MERCHANT_NOISE_PATTERNS: RegExp[] = [
  /^POS\s+/i,
  /^UPI[-/]/i,
  /^NEFT[-/]/i,
  /^IMPS[-/]/i,
  /^RTGS[-/]/i,
  /^ECOM\s+/i,
  /^ACH[-/]/i,
  /^BIL[-/]/i, // bill-pay debit prefix some card statements use
  /\s*\d{6,}$/, // trailing long numeric reference codes
  /\s*\*{2,}\d+$/, // trailing masked card suffix like **1234
];

// Additions above (RTGS-/ACH-/BIL- prefixes) are deliberately confined to the same
// "unambiguous statement-rail prefix, always followed by a separator" shape as the
// existing rules — same conservative bar as the original set. A candidate rule that
// could plausibly eat part of a real (short) merchant name — e.g. stripping a trailing
// 2-3 letter city/state code — was considered and rejected: several real merchants
// (e.g. "PVR", "BPCL") are themselves short all-caps strings, and a rule matching "the
// last short all-caps token" cannot tell those apart from a genuine trailing code
// without a maintained allow-list. Left as an explicit non-fix rather than risking a
// false-positive strip on real merchant names — the "a pattern that matches wrong is
// worse than falling through" principle from statement-parser.ts applies here too.

// A candidate transaction is a likely EXACT duplicate of an existing expense if it
// matches on all three within these tolerances — same day, same merchant (case-
// insensitive), and amount within a tiny rounding tolerance (statement exports
// occasionally round paise differently).
export const EXACT_DUPLICATE_AMOUNT_TOLERANCE = 0.5; // ₹

// A candidate is a likely NEAR duplicate (flagged, lower confidence) if it falls
// within this wider date/amount window — e.g. a transaction posted a day or two later
// than it was authorized, common with card statements.
export const NEAR_DUPLICATE_DATE_TOLERANCE_DAYS = 2;
export const NEAR_DUPLICATE_AMOUNT_TOLERANCE_FRACTION = 0.01; // 1%

export const MIN_CONFIDENCE_FOR_AUTO_SUGGEST_CATEGORY = 0.5;

// --- Merchant category memory (learning feedback loop) ----------------------------
//
// A personal, per-user "merchant -> category" memory that a human's approve/override
// decision writes into (see MerchantMemoryService, IngestionReviewService#approve).
// Confidence decays over time (a merchant's typical category can genuinely drift —
// e.g. a store that used to be a pure grocery merchant starts also selling ready meals)
// rather than a once-learned mapping being trusted forever.

// A freshly-learned merchant gets this starting confidence — deliberately below
// MIN_CONFIDENCE_FOR_MEMORY_AUTO_SUGGEST so a single approval doesn't yet let memory
// skip the AI/ranking step; it takes a little repetition before memory is trusted to
// answer alone. This mirrors detectSubscriptions()'s own "2 hits is plausible, 3+ is
// strong evidence" reasoning for the same kind of small-sample caution.
export const MERCHANT_MEMORY_INITIAL_CONFIDENCE = 0.55;
export const MERCHANT_MEMORY_MAX_CONFIDENCE = 0.97; // never fully 1.0 — always leave room for a future correction
export const MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR = 0.15; // below this, memory is treated as unreliable and ignored (forces AI/rule re-check)
// Each further *agreeing* approval nudges confidence this fraction of the remaining
// distance to the max; each *overriding* correction nudges it the same fraction toward
// the floor. Symmetric on purpose — the system should un-learn a wrong pattern about
// as readily as it learned a right one.
export const MERCHANT_MEMORY_LEARNING_STEP = 0.18;
// If a merchant is overridden to a different category enough times relative to how
// often the existing mapping was accepted, the memory's mapping itself is switched to
// the new category (with a fresh, cautious confidence) rather than just decaying
// toward zero forever — a merchant that has genuinely changed category (e.g. a
// user reclassifies a mixed-use store) should eventually "relearn," not just become a
// permanently-untrusted entry.
export const MERCHANT_MEMORY_OVERRIDE_SWITCH_RATIO = 1; // overrideCount >= acceptedCount triggers a switch
// Confidence halves every this many days without a reinforcing (accepted) approval —
// applied multiplicatively at lookup time, never written back destructively, so a
// merchant that suddenly gets used again still starts from its last known confidence
// times the decay factor rather than from scratch.
export const MERCHANT_MEMORY_DECAY_HALF_LIFE_DAYS = 120;
export const MIN_CONFIDENCE_FOR_MEMORY_AUTO_SUGGEST = 0.62; // above this, skip the AI call entirely for this line
// Fuzzy (embedding-similarity) memory match is only attempted when there is no exact
// normalized-merchant row at all, to keep the extra embedding call off the common
// path — most repeat merchants hit the exact key. See MerchantMemoryService#lookupFuzzy.
export const MERCHANT_MEMORY_FUZZY_MATCH_THRESHOLD = 0.86;
export const MERCHANT_MEMORY_FUZZY_CANDIDATE_LIMIT = 300; // bounds the brute-force cosine scan per user, see rationale in merchant-memory.service.ts

// A merchant needs at least this many total observations (accepted + overridden)
// before its memory is considered "established" for active-learning purposes — fewer
// observations than this always queues the item for human attention even if the raw
// decayed confidence number looks acceptable, since a high confidence built on 1-2
// samples is not yet trustworthy.
export const ACTIVE_LEARNING_MIN_SAMPLE_SIZE = 3;
export const ACTIVE_LEARNING_CONFIDENCE_THRESHOLD = 0.55;

// --- Cross-user global merchant stats (privacy-safe prior) -------------------------
//
// Deliberately the ONLY thing shared across users for this feature: a normalized
// merchant string (already stripped of account/card/reference numbers by
// normalizeMerchantText) mapped to a category *name* (not id — categories are
// per-user rows) with a bare occurrence count. No userId, no amounts, no dates, no raw
// statement text, no embeddings are ever written to this table — see
// MerchantMemoryService#bumpGlobalStat for the redaction guard applied before every
// write. This is a weak prior only: MIN_GLOBAL_STAT_SAMPLES_FOR_SIGNAL gates it out
// entirely until enough independent users have agreed, and its ranking weight
// (SUGGESTION_RANKING_DEFAULT_WEIGHTS.global) starts low relative to personal memory
// and the AI signal.
export const MIN_GLOBAL_STAT_SAMPLES_FOR_SIGNAL = 3;
// Laplace-style smoothing constant — keeps a 1-2 sample global stat from ever
// producing a falsely-confident signal (count / (count + k)).
export const GLOBAL_STAT_SMOOTHING_K = 5;
export const GLOBAL_STAT_MAX_CONFIDENCE = 0.65; // a shared, anonymous, cross-user prior is capped well below what personal memory or a live AI call can reach

// --- Ranking model (learns from corrections) ---------------------------------------
//
// CategoryRankingModel blends up to three independently-produced category candidates
// (personal memory, the AI Gateway's classify() call, the global stat prior) into one
// final suggestion using a per-user weight profile that is nudged after every human
// approval/override — see category-ranking.model.ts. Bounded, symmetric, and simple by
// design (a linear weighted-vote, not a black-box model) — consistent with every other
// "model" in this codebase (MAD z-score, OLS regression, Welch's t-test) being a
// transparent, hand-verifiable classical technique rather than an opaque one.
export const SUGGESTION_RANKING_DEFAULT_WEIGHTS = { memory: 0.5, ai: 0.4, global: 0.1 };
export const SUGGESTION_RANKING_LEARNING_RATE = 0.15;
// Weights are clamped to this range (before renormalization) on every update — a
// single run of corrections can never make the model trust one signal exclusively or
// abandon a signal entirely, keeping the ranking behavior stable across a noisy
// sequence of human decisions.
export const SUGGESTION_RANKING_MIN_WEIGHT = 0.05;
export const SUGGESTION_RANKING_MAX_WEIGHT = 0.85;

// --- Rule-based fallback (AI unavailable, and nothing in memory) -------------------
//
// Always well below MIN_CONFIDENCE_FOR_AUTO_SUGGEST_CATEGORY — a rule-based keyword
// guess is deliberately never confident enough to look like an AI-quality suggestion;
// it exists purely so the review queue still shows *something* actionable (with an
// honest, low confidence and a "rule-based fallback, AI unavailable" rationale) instead
// of an empty suggestion when Groq is down.
export const RULE_BASED_FALLBACK_CONFIDENCE = 0.3;

// --- OCR statement ingestion (extraction confidence) --------------------------------
//
// See parsing/statement-ocr.adapter.ts for why this feature runs its own local
// Tesseract.js adapter rather than depending on the Documents module's OcrAdapter —
// same "cheaper to duplicate than to widen another feature's module exports"
// reasoning already applied to AnomalyDetectionModel in copilot-ingestion.module.ts.
export const OCR_SUPPORTED_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_OCR_IMAGE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB — a photographed statement page, generously bounded
// Below this extraction-confidence score, the batch is still created (never silently
// dropped) but flagged so the UI can warn the user the photo may need to be retaken —
// "no hallucinated fields" applies here too: a low-confidence OCR result is surfaced
// honestly rather than the pipeline pretending the text it extracted is reliable.
export const OCR_LOW_CONFIDENCE_WARNING_THRESHOLD = 0.5;

// --- Document reconciliation (statement vs Expenses vs Loans vs Investments) -------
//
// Keyword heuristics used to classify a parsed line as more likely a loan EMI or an
// investment contribution than a plain expense, purely for routing which comparison
// applies — never used to auto-create or auto-modify a Loan/Investment record, only to
// annotate the review item and to compute the on-demand reconciliation report. See
// reconciliation/reconciliation.service.ts.
export const LOAN_MERCHANT_KEYWORDS = /\b(EMI|LOAN\s*(REPAY|PAYMENT)?|HOME\s*LOAN|AUTO\s*LOAN|PERSONAL\s*LOAN)\b/i;
export const INVESTMENT_MERCHANT_KEYWORDS =
  /\b(SIP|MUTUAL\s*FUND|NPS|PPF|ELSS|ZERODHA|GROWW|UPSTOX|COIN|KUVERA|CAMS|KARVY)\b/i;
// An EMI/contribution line is only matched against a *specific* existing Loan/
// Investment record (rather than just flagged generically) if it falls within this
// amount tolerance of that record's expected value — same "why a tolerance, not exact
// equality" reasoning as duplicate-detection's own amount tolerances (statement
// rounding, minor fee differences).
export const RECONCILIATION_AMOUNT_TOLERANCE_FRACTION = 0.05; // 5%
// A statement line whose merchant string contains a loan/investment keyword but that
// cannot be matched to any existing Loan/Investment record within this many days of
// its own date is reported as a possible *untracked* payment/contribution, not
// silently ignored.
export const RECONCILIATION_DATE_TOLERANCE_DAYS = 5;
