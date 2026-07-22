# WealthOS AI — Phase 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14 + 15

An AI-powered personal wealth operating system for India: daily spending, savings,
investments, loans, tax, insurance, goals, property, documents, and family finance in
one place. This repo covers:

- **Phase 1** — auth, household, home dashboard, income & expenses
- **Phase 2** — investments, loans & debt, insurance, goals
- **Phase 3** — tax planning, retirement planner, alerts & notifications, settings &
  governance, subscription tracking
- **Phase 4** — property portfolio, business tracker, document vault, reports, and a
  mobile-responsive nav
- **Phase 5** — AI Coach (deterministic, DB-grounded Q&A) and the What-If Simulator
  (pure calculation engine + real persistence)
- **Phase 6** — household-wide aggregation across members, with role-based visibility
- **Phase 7** — release readiness: UI polish pass, fixed loading-state gaps, a real
  deployment guide ([`DEPLOYMENT.md`](./DEPLOYMENT.md)), and a Render `PORT`-binding fix
- **Phase 8** — completion pass: edit/update UI for every module that supports it,
  direct unit tests for every previously-untested core service, an initial Prisma
  migration, a CI workflow, frontend test infrastructure, usable Simulator selectors
  (no more raw IDs), and a `LICENSE` file
- **Phase 9** — audit remediation pass: Business module brought to full CRUD parity,
  a deliberate (and now honestly documented) decision to keep Subscriptions a derived
  view rather than a first-class entity, a real portfolio rebalancer, a reusable
  Redis-backed rate-limit guard applied to the most expensive route, and removal of
  dead `household-views` scaffolding. See "Phase 9" below for exactly what changed and,
  just as importantly, what was deliberately **not** attempted in this pass and why.

All real, wired, and runnable end to end — database to UI. The native mobile app and
the AI/ML layer described in the original product brief (local LLM gateway, RAG search,
ML-based insights, an agentic coach and scenario studio) are the remaining major scope
items — intentionally left for dedicated follow-up passes rather than stubbed out
half-working. See "Phase 9 — AI/ML roadmap" below for what that would take and in what
order it makes sense to build it.

> **Disclaimer**: WealthOS AI provides projections and explainable, rules-based
> insights based on the data you enter. It is not financial, tax, or legal advice, and
> nothing in this product is a guarantee of future outcomes.

## Why it's built this way

The full product brief covers 20 modules, an LLM-grounded AI chat layer, a life
simulator, and a mobile app. Generating all of that as genuinely working code in one
pass isn't realistic — it would produce a lot of code that *looks* complete but doesn't
actually run together. Instead, this repo is a fully wired set of vertical slices: real
Postgres schema → real NestJS API → real Next.js UI, with seed data you can log in and
use today. Each additional module gets added the same way, one at a time, so the repo
is always in a runnable state — and each pass audits the previous one (route parity,
schema drift, brace balance, missing mocks, **module DI exports**) before adding
anything new. Run `npm run audit` any time to re-check the first three of those.

## Architecture

```
wealthos-ai/
├── apps/
│   ├── api/          NestJS backend
│   │   └── src/        auth · users · household · income · expenses ·
│   │                    investments · loans · insurance · goals ·
│   │                    tax · retirement · alerts · settings ·
│   │                    property · business · documents · reports · dashboard ·
│   │                    ai (Gateway/ops P10, rag/ P11, coach/ P12, scenario-studio/ P13,
│   │                        ml-insights/ P14, copilot-ingestion/ P15)
│   └── web/           Next.js 14 App Router frontend
├── packages/
│   ├── db/            Prisma schema, migrations, seed data, shared client
│   └── types/          Shared TypeScript DTOs used by both apps
├── docker-compose.yml  Local Postgres + Redis (free, self-hosted — no paid services)
└── package.json         npm workspaces root
```

**Stack**: Next.js App Router + TypeScript + Tailwind (frontend) · NestJS + Prisma +
PostgreSQL + Redis (backend) · npm workspaces monorepo. Everything runs free/locally —
no paid APIs or managed services required for the MVP.

**Auth**: passwordless email OTP, session-based (httpOnly cookie + Redis + Postgres
`Session` table). OTP delivery is mocked (logged to the API console) behind an
`OtpDeliveryAdapter` interface — swap in a real provider later without touching the
auth flow.

**Financial health score & insights**: a deterministic, explainable rules engine
(`apps/api/src/dashboard/dashboard.service.ts`). Net worth = cash + investments +
property value − outstanding debt.

**Document vault**: file bytes are stored on local/self-hosted disk
(`apps/api/storage/documents/`) behind a `DocumentStorageAdapter` interface — swap in an
S3-compatible adapter (e.g. MinIO) later without touching `DocumentsService` or the
schema. `storageKey` is always an opaque UUID, never a client-supplied path. OCR/text
extraction is a real pipeline stage (status machine: `PENDING → DONE/FAILED`, plus
`ocrText`/`summary` fields) behind an `OcrAdapter` interface, currently backed by a
deterministic mock rather than a paid vision API.

**Business tracker**: business P&L is tracked separately from personal Income by
design — auto-merging business profit into personal taxable income would risk silent
double-counting, since the owner is expected to log their own drawings/salary as
personal Income. Business profit does feed into the Reports module (read-only
aggregation), and business obligations (GST filings, etc.) feed into the Alerts engine.

**Reports**: monthly and yearly summaries computed server-side
(`apps/api/src/reports/reports.service.ts`), reused by both the Reports page and a CSV
export endpoint — never recomputed in a page component.

**AI Coach**: NOT an LLM — a deterministic intent router (`coach.intents.ts`) that
matches a question to one of a fixed set of intents, then answers using only that
intent's corresponding existing service's *live, DB-backed* data for the requesting
user (net worth, goals, tax, retirement, insurance, investments, spending, risk
profile, alerts). Every interaction (including refusals) is logged to
`CoachInteraction` for audit. Unmatched questions are refused outright; a *matched*
question the DB genuinely can't answer (e.g. "why did this change" — no historical
snapshots are stored) is answered as insufficient-data, not guessed at. See
`apps/api/test/coach.service.spec.ts` for the scoping/refusal tests.

**What-If Simulator**: split cleanly into a pure calculation layer
(`simulator.engine.ts` — no DB access, same inputs always produce the same outputs) and
an impure orchestration layer (`simulator.service.ts` — gathers real baseline/context
data from the DB, validates params, and owns `SavedScenario` persistence). Loan
prepayment and retirement-age scenarios reuse the *real* amortization/corpus math from
LoansService/RetirementService rather than approximating it. See
`apps/api/test/simulator.engine.spec.ts` for the pure-function edge cases and
`simulator.service.spec.ts` for the persistence/comparison tests.

**Household-wide views**: no schema change was needed — `Household.members`,
`User.householdId`, and `User.role` (`OWNER`/`MEMBER`) already modeled this correctly
back in Phase 1. `HouseholdService.getHouseholdSummary` sums each member's own
Income/Expense/Investment/Loan/Property/Goal/Business totals exactly once (member lists
come straight from the `Household.members` relation, which has no duplicates by
construction — see the code comment on `gatherMemberFinancials` for the full "no double
counting" reasoning). `MEMBER` viewers get aggregate rollups only; `OWNER` viewers get a
per-person dashboard-level breakdown — never raw transaction rows, even for the owner.
Recurring charges detected for 2+ members are flagged as *possibly* shared rather than
silently summed or deduped, since the data alone can't say whether it's one shared
account or two coincidentally same-named ones. See
`apps/api/test/household.service.spec.ts` for the permission-boundary and
no-double-counting tests.

## Getting started

Requires Node 20+, Docker (for local Postgres/Redis), and npm.

```bash
# 1. Install dependencies
npm install

# 2. Start local infra (free, self-hosted)
docker compose up -d

# 3. Configure environment
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 4. Set up the database
npm run db:generate
npm run db:migrate
npm run db:seed

# 5. Run both apps (in separate terminals)
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

Demo login: `demo@wealthos.ai` (household OWNER). A second household member,
`demo-member@wealthos.ai` (MEMBER role, smaller financial footprint), is also seeded so
the Household page's per-member breakdown and aggregation totals are genuinely
demoable — log in as either to see the OWNER vs. MEMBER view difference. Since OTP
delivery is mocked, watch the `dev:api` terminal for a line like
`[DEV ONLY] OTP for demo@wealthos.ai: 482913`.

Uploaded documents are written to `apps/api/storage/documents/` by default (override
with `DOCUMENT_STORAGE_PATH` in `apps/api/.env`). This folder is gitignored except for
a `.gitkeep`.

**Deploying this to the internet (GitHub → Render → Vercel)?** See
[`DEPLOYMENT.md`](./DEPLOYMENT.md) for a step-by-step guide, including a release
checklist and the one thing every first-time deploy trips on (no Prisma migration has
been generated yet — the guide covers exactly how to create one).

## Phase 9 — audit remediation pass

A prior audit (not included in this repo) flagged 18 gaps against the original product
brief. This pass works through the ones that are genuinely completable as real, tested,
runnable code without infrastructure this environment can't provide (a running local
LLM, a running vector DB). The rest are documented honestly below rather than fudged.

**Done this pass:**

- **Business — full CRUD.** `Business`, `BusinessTransaction`, and `BusinessObligation`
  now all support `PATCH` (previously create/read/delete only). `Business` gained
  `entityType`, `currency`, `startedAt`, `ownershipPercent`; `BusinessObligation` gained
  `vendor` and `status` (`PENDING`/`PAID`/`OVERDUE`/`CANCELLED`) so obligations can be
  tracked through their lifecycle instead of deleted once paid. New migration:
  `packages/db/prisma/migrations/20260718000000_business_crud_and_rebalance_support/`.
  Real inline edit forms for all three record types on the Business page, with
  loading/saving/error states via the existing `InlineEditForm` component. Ownership
  boundaries and update validation covered in `apps/api/test/business.service.spec.ts`.
- **Subscriptions — decided: stays a derived view (Option B), not a first-class model.**
  Considered promoting it to a real `Subscription` table with its own renewal date and
  cancel-tracking, and deliberately rejected that for now: a user-editable Subscription
  record can silently drift from the Expense rows it's supposed to summarize, and nothing
  in the product today needs subscription-specific fields Expense doesn't already have.
  What changed instead: `detectSubscriptions` now returns `confidence`
  (`MEDIUM` at 2 occurrences in 3 months, `HIGH` at 3+), `lastSeenAt`, and
  `sourceExpenseIds` so the UI can show its work rather than asserting a merchant is a
  subscription with no way to double-check. The Subscriptions page now surfaces all of
  that and says plainly that it's a detector, not a place to add/edit records — go fix
  the source Expense instead. If a future pass needs true subscription lifecycle
  tracking (e.g. renewal alerts with a user-set next-bill date), promoting to a real
  model is still the right call then — just not speculatively now.
- **Portfolio rebalancer.** `InvestmentsService.rebalance()` (backend) + a "Rebalance"
  panel on the Investments page (frontend): given a target allocation (must sum to
  100%) and optional new cash to deploy, computes BUY/SELL/HOLD per investment type to
  reach it. Supports "don't sell" constraints per type (e.g. a PPF that's illiquid) —
  documented as a deliberate simplification: a constrained type is held at its current
  value and flagged `constrained: true` rather than having the shortfall silently
  redistributed onto other types, which would need a real constrained-optimization
  solver to do correctly. O(n) in the number of distinct investment types. Six test
  cases in `apps/api/test/investments.service.spec.ts` cover the 100%-sum validation,
  empty-portfolio rejection, sell-to-fund-buy, cash-only deployment (no sells needed),
  the no-sell constraint, and buying into a type with zero current holding.
- **Rate limiting generalized beyond OTP.** New `@RateLimit(limit, windowSeconds)`
  decorator + `RateLimitGuard` (`apps/api/src/common/`) reuse the same Redis
  incr-with-expiry pattern `AuthService` already used for OTP, but as an opt-in,
  route-scoped guard any endpoint can adopt. Applied to `POST /documents` (30/hour/user)
  since document upload runs OCR inline and writes to disk — the single most expensive
  write in the app today. Not applied globally: most routes are cheap CRUD against the
  user's own rows behind session auth already, and a blanket throttle without real usage
  data risks getting limits wrong in both directions. **This is the reusable mechanism
  the eventual AI routes (search/coach/scenario generation/ingestion) should adopt the
  day they exist** — see the AI/ML roadmap below.
- **`household-views/` dead scaffolding removed.** It was an empty, unimported
  directory — the real household-aggregation feature already lives in
  `household.service.ts` (see Phase 6). Confirmed zero references anywhere in the repo
  before deleting.
- **Alert DSL — decided: not building a user-authored rule language.** Alerts stay a
  fixed, deterministic rule set in `alerts.service.ts` (the code already comments why:
  "so every alert is explainable"). A parser/AST/evaluator for user-defined rules is a
  real feature, not a quick add, and nothing in the product today has asked for
  user-authored rules — building one speculatively would be exactly the kind of
  scope-for-its-own-sake this repo has been trying to avoid since Phase 1. If/when a
  concrete need shows up (e.g. "alert me if any category exceeds ₹X this month"), that's
  a scoped, testable follow-up, not a rewrite.
- **OCR — stays mocked, now with the limitation stated up front** (see "Known
  limitations" below) rather than left implicit in a code comment. A real OCR adapter
  (e.g. Tesseract) is still the right long-term move; it wasn't done in this pass
  because it changes the runtime dependency footprint (a Tesseract binary or a
  Python/Node OCR library) in a way that deserves its own reviewed pass, not a
  drive-by swap bundled into an unrelated Business-CRUD change.

**Deliberately not attempted this pass, with reasoning — the AI/ML roadmap:**

The original brief also asked for: an `AiGatewayService` calling a local/open-source
LLM, a RAG subsystem over documents/reports/coach history backed by a vector store, an
ML-based `InsightsService` (anomaly detection, habit classification, a trained risk
score), an agentic Coach 2.0 layer on top of the existing deterministic router, a
natural-language Scenario Studio on top of the Simulator, Copilot ingestion for
statements, a History/Financial Memory timeline with AI explanations, a timeline index
data structure, and a background job queue.

None of that is in this pass. Not because it isn't valuable — because doing it honestly
requires infrastructure this build environment cannot provide or verify: a running
Ollama/local-LLM endpoint, a running vector database, and a way to actually execute and
test the resulting network calls. Writing the *code* without ever running it against a
real model/vector store would produce exactly the kind of "looks complete, doesn't
actually work" output this repo's own Phase-1 philosophy (see above) was written to
avoid. Recommended build order for a follow-up pass, once that infrastructure exists:

1. **`AiGatewayService`** first — a thin, well-tested HTTP client to a configurable
   local model endpoint (`AI_GATEWAY_URL`, `AI_MODEL_NAME`, `AI_TIMEOUT_MS`) with
   `generateText`/`structuredCall`/`summarize`. Everything else depends on this
   existing and being reliable (timeouts, error mapping, safe JSON parsing of
   structured output) before it's worth building on top of.
2. **RAG subsystem** next, since AI Search and "explain this period" both need it:
   embed + index document text / report summaries / coach history into a vector store,
   `POST /ai/search` that retrieves top-k, assembles context, and asks AiGateway to
   answer *grounded only in what was retrieved* — with an explicit "the data doesn't
   support a confident answer" fallback rather than letting the model fill gaps.
3. **Coach 2.0 (agentic layer)** on top of both — keep the existing deterministic
   intent router as the context planner (it already does the DB-grounded part
   correctly and cheaply); add the AiGateway as an explanation layer on top of that
   plan, not a replacement for it. Store `CoachAdvice` with a context snapshot so
   advice is auditable after the fact.
4. **Scenario Studio, Copilot ingestion, ML InsightsService, History timeline** can
   follow in roughly that order — each is a real, scoped feature once the Gateway/RAG
   foundation exists, but building any of them first would mean re-doing the AI
   plumbing three separate times.
5. **Background job queue** (BullMQ over the existing Redis instance is the natural
   fit) should land alongside step 1 or 2, not after — real OCR and any LLM call are
   slow enough that they shouldn't block an HTTP request/response cycle, and adding a
   queue after the fact means reworking whatever synchronous version shipped first.
6. **Timeline index** (interval/segment tree for fast time-range queries) only earns
   its complexity once the History timeline in step 4 exists and has enough real data
   for a linear scan to actually be slow — building it earlier would be optimizing a
   feature that doesn't exist yet.

If AI/ML is the priority for the next pass, say so explicitly and it can be tackled
as its own focused effort — ideally with access to a real local-LLM endpoint and vector
store to build and test against, rather than as one line item among seventeen others.

## Phase 10 — AI Gateway foundation

The Phase 9 roadmap above recommended `AiGatewayService` as the first real AI-layer
piece, gated on having an actual runnable model endpoint to build and verify against.
That gate is now cleared, on different terms than originally scoped: rather than a
self-hosted local LLM (Ollama), this pass uses **Groq's free tier**, which serves
open-source models (Llama 3.1/3.3) over an OpenAI-compatible HTTP API at no cost and
needs no GPU box of our own — a deliberate, explicit trade against "fully
self-hosted", made because no such box was available. See `apps/api/src/ai/`.

**What's built:**

- **AiGatewayService** (`ai/gateway/ai-gateway.service.ts`) — the one place in the
  codebase that talks to a model. `classify()` / `extract()` / `generate()` /
  `summarize()` / `rank()` all funnel through one pipeline: redact free text
  (`RedactionService`) → trim to a token budget (`TokenBudgetService`, a documented
  ~4-chars/token heuristic, not a real tokenizer) → check the Redis cache for
  cacheable task types → resolve a versioned prompt (`PromptRegistryService`) → route
  to a small or large Groq model by task type (`ModelRouterService`) → call Groq,
  requiring JSON output shaped like the caller's zod schema wrapped in a
  self-reported confidence envelope → validate (`SchemaValidatorService`), retrying
  up to twice with the validation issues fed back to the model as a correction
  instruction → log the interaction → return. Every call is logged to
  `AiInteractionLog` regardless of outcome.
- **Confidence is self-reported, not calibrated.** The model is asked to state its own
  0–1 confidence alongside its answer. Groq's chat completions endpoint doesn't expose
  the logprob access a real calibrated score would need, and building a separate
  calibration model was out of scope for this pass. Treat it as a rough "how sure did
  the model say it was" signal for a UI badge, not as a statistic worth further math.
  Stated here rather than left implicit, per this repo's own honesty standard.
- **Ops layer**: `AiLoggingService` (every call → `AiInteractionLog`, never blocks the
  caller if the write itself fails), `AiCacheService` (Redis, keyed by a hash of
  feature+prompt+input, TTL configurable), `RedactionService` (regex-based — catches
  email/phone/PAN/Aadhaar/card-shaped substrings in free text before it leaves the
  process; does not touch names, amounts, or the structured context a caller
  assembles from the DB, since redacting that would break grounding for no safety
  gain), `TokenBudgetService`, `PromptRegistryService` (versioned templates in
  `AiPromptVersion`, upserted idempotently on boot from an in-code registry — no admin
  UI to edit prompts yet, bumping one today means a code change).
- **Background queue**: `AiQueueService` wraps BullMQ over the existing Redis
  instance. Postgres (`AiJob`) is the status source of truth, same pattern as
  `Session` — BullMQ is transport only, nothing reads job state back out of it.
  `enqueue()` supports an optional per-user idempotency key (`@@unique([userId,
  idempotencyKey])`) so a retried HTTP request can't double-enqueue. Handlers register
  by name via `registerHandler()` — this file has no built-in knowledge of what job
  types exist, so RAG indexing, Coach planning runs, etc. can each register their own
  handler from their own module once those phases land. `AiQueueProcessor` runs the
  BullMQ worker **in-process** with the API, not as a separate deployment — a
  deliberate simplification for now; splitting it out is a real but separable
  follow-up once job volume/latency actually calls for it.
- **One real end-to-end feature**: a health self-test (`POST /ai/health/self-test` →
  enqueues → worker calls `AiGatewayService.classify()` against a trivial "ping"
  prompt → `GET /ai/jobs/:id` to poll the result). Not a product feature — it exists so
  the whole pipeline (queue → worker → gateway → Groq → validation → logging → job
  status) is exercised by something concrete rather than shipped entirely unverified
  ahead of RAG/Coach 2.0. `GET /ai/health` (unauthenticated, read-only) reports
  config presence plus log/queue-derived stats over the last hour — it does **not**
  call Groq live, so polling it for uptime monitoring doesn't burn model quota.
- **Migration**: `packages/db/prisma/migrations/20260719000000_ai_gateway_foundation/`
  — three new tables (`AiPromptVersion`, `AiInteractionLog`, `AiJob`), additive only,
  same hand-derivation caveat as every prior migration (see below).

**Known limitation specific to this pass:** this build environment's network egress is
restricted to package registries (npm, PyPI, GitHub) — it cannot reach `api.groq.com`.
Every file above is written to Groq's documented OpenAI-compatible API contract and
covered by tests that mock the HTTP/queue layer (`apps/api/test/ai-gateway.service.spec.ts`,
`ai-queue.service.spec.ts`, `ai-gateway-primitives.spec.ts`), but none of it has been
exercised against a live Groq endpoint. Set a real `GROQ_API_KEY` and run
`POST /ai/health/self-test` once you pull this down — that first real call is the
actual integration test this environment couldn't perform. This is the same class of
limitation the Phase 9 section above already flagged for a local-LLM approach; it
didn't go away by switching to a hosted free tier, it just moved from "no endpoint
exists" to "the endpoint exists but I can't reach it from here."

**Not built in this pass, by design** — this was scoped as gateway + ops
infrastructure only, per the confirmed build order (Gateway first, since RAG, Coach
2.0, Scenario Studio, Copilot Ingestion, ML Insights, and the Memory/Timeline all
depend on it existing and being reliable before it's worth building on top of). None
of those six features exist yet. Next up per the original roadmap: RAG, then Coach 2.0
as an explanation layer over the existing deterministic intent router (not a
replacement for it).

## Phase 11 — RAG engine

Builds on Phase 10's AiGatewayService/AiQueueService rather than calling Groq
directly anywhere. See `apps/api/src/ai/rag/`.

**What's built:**

- **Indexing** (`RagIndexingService`) — pulls a user's own Documents (OCR text +
  summary), Reports (computed on demand, indexed as of reindex time), Coach
  interaction history, Alerts, and a current financial snapshot from
  `DashboardService`; chunks each with `ChunkerService` (paragraph/sentence-aware,
  ~180 words per chunk with 30-word overlap); embeds each chunk locally with
  `EmbeddingService`; stores the result in `AiEmbeddingChunk`. Runs as a background
  job (`rag.reindex.user`, registered against Phase 10's `AiQueueService`) — full
  delete-and-rebuild per user rather than incremental, a deliberate simplification
  documented in the service's own doc comment. Triggered via `POST
  /ai/search/reindex`; **not yet wired to run automatically** when a document is
  uploaded or a new coach interaction happens — a real gap, called out rather than
  hidden, and a natural fast-follow once this phase is reviewed.
- **Embeddings are local, not Groq.** `EmbeddingService` runs `Xenova/all-MiniLM-L6-v2`
  in-process via `@xenova/transformers` (WASM, CPU-only, ~90MB, no API key) — cheap
  enough that self-hosting is genuinely practical here, unlike the larger
  generation/reasoning calls this app routes to Groq. Same network caveat as Phase 10:
  the library needs one-time outbound access to huggingface.co to download the model
  weights, which this build sandbox doesn't have either — written correctly against
  the library's documented API, not exercised end-to-end here. See the class's own doc
  comment for what your deployment target needs (egress once, and disk for the cache).
- **Storage is a plain array column, not pgvector.** This environment's Postgres image
  doesn't have the pgvector extension, and Prisma's support for it needs an
  `Unsupported("vector(n)")` field plus raw SQL regardless. Retrieval does
  application-level brute-force cosine similarity scoped to one user's chunks at a
  time (`HybridRetrievalService`) — correct and fast enough at realistic per-user
  volumes (at most a few hundred chunks), and it can never accidentally compute
  similarity against another user's data because the Prisma query filters by `userId`
  before anything is scored. See the Phase 11 migration's comment for the upgrade path
  if data volume ever actually calls for pgvector.
- **Hybrid retrieval**: semantic (cosine similarity) + keyword (a real BM25
  implementation, `KeywordScorerService` — not a substring match) + recency
  (exponential decay, 90-day half-life) + source-priority (a hand-set trust weight per
  source type — Documents/Reports weighted above Alerts) combined into one score. All
  four weights and the recency half-life are named constants in `rag.constants.ts`,
  not scattered magic numbers.
- **Query rewriting + multi-hop decomposition** (`QueryRewriteService`, via
  `AiGatewayService.extract()`): produces 1-3 alternate phrasings to improve recall,
  and detects genuinely compound questions ("compare this month to last month and
  tell me if I'm on track"), decomposing them into sub-questions that each get their
  own retrieval pass, merged before reranking. Falls back to searching the original
  query verbatim if the rewrite call itself is unavailable — an enhancement, not a
  hard dependency.
- **Reranking** (`RerankingService`, via `AiGatewayService.rank()` — the same method
  Phase 10 shipped, now with a real caller): reorders hybrid retrieval's top 20
  candidates down to the best 6 before they reach synthesis. Falls back to hybrid
  retrieval's own combined-score order if the rerank call is unavailable.
- **Citation-aware, no-evidence-aware synthesis** (`AnswerSynthesisService`): answers
  strictly from the reranked, numbered source list and must cite which indices it
  used; if the sources don't actually support an answer, it says so instead of
  guessing. Below `MIN_EVIDENCE_SIMILARITY` (0.35 cosine similarity), `RagService`
  skips reranking and synthesis entirely and returns the no-evidence response directly
  — this is enforced in code, not just prompted for.
- **Confidence, twice over**: `retrievalConfidence` (top chunk's semantic similarity
  averaged with the reranker's self-reported confidence in its ordering) and
  `answerConfidence` (the synthesis call's own self-report) are surfaced separately —
  same self-reported-not-calibrated caveat as Phase 10's confidence scores throughout.
- **Frontend**: `/ai-search` — query box, source-type and date-range filters, cited
  source cards with snippets, both confidence badges, a "why these sources were used"
  explanation panel (including the sub-question breakdown for multi-hop queries), and
  a manual reindex button. Added to the top nav.
- **Every search is logged** to `AiSearchLog` (query, rewrites, retrieved vs. cited
  chunk ids, confidence, answer) — what powers `GET /ai/search/history` and the audit
  trail for "what did this search actually use".
- Tests: chunking (paragraph splitting, overlap), BM25 scoring, hybrid retrieval's
  score combination and per-user scoping, reranking's fallback behavior, and
  `RagService`'s no-evidence short-circuit and full-pipeline orchestration — all
  covered in `apps/api/test/`, with the environment caveat below.

**Known limitations specific to this pass:**

- Reports and the financial snapshot are indexed as **current state as of the last
  reindex**, not a real historical time series — there's no periodic-snapshot store
  anywhere in this app yet (same limitation the Phase 9 section already flagged for
  Coach's "why did X change" questions). Asking AI Search "how did my net worth change
  over the last six months" will not find six months of distinct snapshots to compare,
  because none exist.
- No automatic reindex-on-upload/on-coach-answer yet — reindexing is manual (`POST
  /ai/search/reindex`) until that's wired in.
- Same test-environment caveat as Phase 10: any test file that transitively imports
  `PrismaService` fails to even load in this sandbox (`@prisma/client did not
  initialize yet`) because `prisma generate` can't reach its engine binary host from
  here — confirmed to be pre-existing and identical on completely untouched test files
  (e.g. `goals.service.spec.ts`), not something this phase introduced. The
  Prisma-independent tests (chunking, BM25, reranking's pure logic paths) pass
  cleanly; the rest are correct by code review and consistent with the patterns Phase
  10's tests already validated, but genuinely unverified by a live test run here.

**Not built in this pass:** ML Insights, an agentic Coach layer, Scenario Studio,
Copilot Ingestion, and the Financial Memory/Timeline all remain future phases, per the
original roadmap order. (Coach 2.0 landed next — see "Phase 12" below.)

## Phase 12 — Agentic Coach

This is the "explanation layer over the existing deterministic intent router, not a
replacement" the roadmap called for, built for real. See `apps/api/src/ai/coach/`.
CoachModule (Phase 5) is **not modified** — `/coach/ask` and `/coach/history` behave
exactly as before this phase existed. Everything here is additive, under `/coach/v2/*`.

**What's built:**

- **Intent classification tries the deterministic router first, always**
  (`IntentClassifierService`). `matchIntent()` — the original Phase 5 keyword router —
  runs first and wins if it matches anything at all; the model is only ever consulted
  (`AiGatewayService.classify()`, five labels) for questions that router doesn't
  recognize. A known question about net worth, tax, goals, etc. takes the exact same
  path it always did, just with an explanation composed around it afterward.
- **A real planner** (`PlannerService`) decides, per classified question, which stages
  actually need to run — e.g. `general_search` skips composition entirely (RAG already
  produced a grounded, cited answer) and skips verification for the same reason; the
  deterministic path composes but never needs verification (the base answer is code
  output, not a model claim); the four computed advanced intents need both. The
  decision and its reasoning are recorded as plain-language steps on
  `AgenticCoachRun.plan`, not left implicit in control flow.
- **Deterministic data gathering** (`DataGathererService`) for four advanced
  categories — all real math computed in code, the model never touches a calculation:
  - `prioritize_actions` — open alerts + off-track goals, ranked by
    `AiGatewayService.rank()` (the same method Phase 11's reranker uses).
  - `goal_conflict` — sums committed vs. required monthly goal contributions against
    actual monthly surplus (income − expenses − EMIs, all from existing services) and
    flags overcommitment / unreachable targets as booleans computed in code.
  - `risk_tradeoff` — compares the user's highest-interest loan rate against their own
    stated expected investment return (from their retirement profile, not a hardcoded
    assumption) to frame a debt-vs-invest tradeoff.
  - `compare_periods` — parses which two months a question means (`AiGatewayService.extract()`,
    defaulting to this-month-vs-last-month), then computes the income/expense/savings-rate
    diff in code from `ReportsService`'s existing monthly report.
  - `general_search` delegates straight to Phase 11's `RagService`.
- **Numeric-consistency verification is enforced in code, not just prompted for**
  (`NumericConsistencyVerifier`). Every number the composer's output contains must
  trace back (within a documented tolerance — 1% relative for amounts, 0.15 absolute
  for percentages, to allow for rounding) to a number already present in the gathered
  facts. If a composed answer introduces even one figure that doesn't match, it is
  **discarded** — the response falls back to the raw facts themselves, which are
  always safe because they're deterministic computation, never model output. This is
  the concrete, testable version of "produce a final answer only after verifying it
  against available facts" from the roadmap.
- **Memory that actually compares data, not just question text**
  (`CoachMemoryService`). Every run's structured facts are hashed and compared against
  the most recent prior run for the same intent; the result is a note telling the user
  either "this matches what I told you last time — nothing's changed" or "your data
  has changed since last time — this isn't what you might remember." This is what
  "remember previous advice and avoid repeating itself" / "detect when advice is stale
  because the user's data changed" means here: a real comparison of stored facts, not
  a heuristic on the question string.
- **Graceful degradation everywhere a model call could fail**: classification falls
  back to `general_search`; query/period parsing falls back to sensible defaults;
  composition failures fall back to the raw facts or (on the deterministic path) the
  original grounded answer verbatim. No advanced-path failure mode leaves the user
  with an error instead of an answer — worst case, they get the underlying numbers
  without the narrative wrapper.
- **Frontend**: `/coach` now has a Deterministic/Advanced toggle. Deterministic mode
  is pixel-identical to the original Phase 5 page (same copy, same "no external model
  involved" framing — still true for that mode). Advanced mode adds: intent filters,
  a confidence badge, a stale/repeated-advice note, and an expandable section per
  answer showing the plan steps taken, the raw evidence JSON, and linked source chunk
  ids for `general_search` answers.
- Tests: `NumericConsistencyVerifier` (8 cases — matching, mismatched, rounding
  tolerance, percent-vs-plain-number, zero-noise), `PlannerService` (composition/
  verification-needed per path), `IntentClassifierService` (deterministic-first
  routing, advanced classification, unavailable-gateway fallback), and
  `AgenticCoachService` (deterministic composition + its fallback, general_search
  bypassing composition, verification-failure fallback, stale-advice note
  propagation) — 20 new tests total, `apps/api/test/`. Writing these caught two real
  bugs before they shipped: a type mismatch in `PlannerService`'s step objects, and a
  wrong relative import path in `AgenticCoachService` — both fixed, both confirmed by
  a clean rerun.

**Known limitations specific to this pass:**

- `compare_periods` and `risk_tradeoff` inherit the same "no stored history" gap
  flagged since Phase 9: reports are computed on demand from current data, so a
  comparison is only ever as good as what `ReportsService` can compute for two named
  months, and the debt-vs-invest framing uses the user's *stated* expected return, not
  any real forecasting.
- Same test-environment caveat as Phases 10–11: any test importing `PrismaService`
  (directly or transitively — including through the untouched Phase 5
  `coach.service.ts`) fails to load in this sandbox because `prisma generate` can't
  reach its engine binary host from here. Confirmed to be the identical pre-existing
  limitation, not something this phase introduced — the Prisma-independent tests
  (verifier, planner, classifier's pure-fallback paths) pass cleanly.
- The composer is asked for a single best-effort answer per call — it doesn't yet
  retry with a *different* phrasing when verification fails (only the raw-facts
  fallback), unlike `AiGatewayService`'s own malformed-JSON retry loop. A worthwhile
  fast-follow if verification failures turn out to be common in practice.

**Not built in this pass:** ML Insights, Copilot Ingestion, and the Financial
Memory/Timeline remain future phases. (Scenario Studio landed next — see "Phase 13"
below.)

## Phase 13 — Scenario Studio

Built entirely on top of the existing deterministic `SimulatorService`/
`simulator.engine.ts` (Phase 5) — every variant's numbers come from that same, already-
tested engine re-run with different parameters. Nothing in this phase invents a
financial projection; the AI layer only parses prompts into structured params and
explains an already-computed ranking. See `apps/api/src/ai/scenario-studio/`.

**What's built:**

- **Prompt parsing** (`ScenarioPromptParserService`) turns a natural-language what-if
  into one of the 9 existing `ScenarioType`s plus its params
  (`AiGatewayService.extract()`). Explicitly instructed not to guess large ambiguous
  amounts (property value, lump sum) it wasn't given — `SimulatorService`'s own
  existing field validation is still the real authority; a bad parse just surfaces as
  a clear "missing detail" message instead of silently proceeding with an invented
  number.
- **Scenario expansion** (`ScenarioExpanderService`) generates best/base/worst/
  constrained variants by deterministically perturbing the scenario's primary numeric
  field — direction-aware (increasing a "salary hike" is optimistic, increasing an
  "emergency expense" is pessimistic — see `scenario-studio.constants.ts`'s config
  table) and using named, tunable multipliers, never a model-invented number. The
  **constrained** variant is the genuinely new one: for the three real discretionary-
  spend decisions (`SIP_INCREASE`, `LOAN_PREPAYMENT`, `HOUSE_PURCHASE`) it's capped
  against an actual affordability calculation — available monthly surplus for SIP, an
  EMI-affordability inversion (a real formula, not a guess) for house value, and a
  conservative fraction of current investment value for a prepayment lump sum.
  `RETIREMENT_AGE_SHIFT`'s age field gets hand-written variant logic instead of the
  generic multiplier path, since multiplying an absolute age is meaningless.
- **Sensitivity analysis** (`SensitivityAnalysisService`) sweeps the scenario's
  primary field across 5 points (or 5 age deltas for retirement) by literally re-
  calling `SimulatorService.run()` — real re-runs of the real engine, not
  extrapolation. Every sweep also gets a **return-rate sensitivity** dimension,
  computed directly via the engine's exported `projectNetWorth()` at 6/8/10/12/14%
  assumed returns. This is the documented, honest substitute for the roadmap's
  requested "inflation changes" dimension — `simulator.engine.ts` models an assumed
  investment return rate, not expense inflation, and there was no real inflation
  calculation to back a fabricated one, so this reuses the lever that actually exists
  instead.
- **Ranking** (`ScenarioRankingService`) is a deterministic score — projected net
  worth change, with any infeasible variant unconditionally penalized below every
  feasible one regardless of its raw number (a "best case" that assumes spending money
  the user doesn't have shouldn't rank first). Optional per-goal impact notes when
  `targetGoalIds` are passed, comparing a variant's cashflow delta against each named
  goal's required monthly contribution — a real comparison, not a re-simulation of the
  goal's own trajectory (the engine doesn't model that).
- **Explanation** (`ScenarioExplainerService`) reuses Phase 12's
  `NumericConsistencyVerifier` directly — the same code-enforced guardrail against
  invented figures, applied here to "why did this variant win" instead of a coach
  answer. A failed verification falls back to the raw facts summary, same pattern as
  Phase 12.
- **Frontend**: `/scenario-studio` — a prompt box, a 4-up variant grid (best/base/
  worst/constrained, ranked #1 first, feasibility warnings and goal-impact notes
  inline), an explanation panel with a confidence badge, and a sensitivity chart per
  dimension.
- Tests: `affordability.util` (5 cases, including a round-trip check that the EMI
  inversion produces the exact EMI it targets), `ScenarioExpanderService` (direction-
  aware multipliers, affordability capping, infeasibility detection, the age special
  case), `ScenarioRankingService` (pure ranking, the infeasibility-penalty guarantee,
  goal-impact notes), `SensitivityAnalysisService` (sweep point counts/values, the
  age-delta path, the always-present return-rate dimension), and
  `ScenarioExplainerService` (verification pass/fail/unavailable fallbacks) — 24 new
  tests. Writing the sensitivity test caught one real bug (a test-only TypeScript
  literal-widening issue, fixed and confirmed by a clean rerun) — no production code
  needed fixing this phase.

**Known limitations specific to this pass:**

- Every variant/sensitivity point varies exactly one numeric field per scenario type
  (documented in `scenario-studio.constants.ts`) — `HOUSE_PURCHASE` has four numeric
  inputs but only `propertyValue` varies across variants; interest rate and tenure
  stay at the user's literal input in every variant. A genuine scope limit, not an
  oversight.
- The goal-impact note is a simple cashflow-delta-vs-required-contribution comparison,
  not a full re-simulation of how a given goal's own probability-of-success would
  shift under each variant — the underlying engine doesn't model that connection.
- Same test-environment caveat as every AI phase so far: any test importing
  `PrismaService` (directly or transitively — including through untouched Phase 5
  files like `simulator.service.ts` and `goals.service.ts`) fails to load here because
  `prisma generate` can't reach its engine binary host from this sandbox. Confirmed
  identical and pre-existing, not introduced by this phase — the Prisma-independent
  tests (`affordability.util`, and the ones that only need mocked constructor params)
  pass cleanly.

**Not built in this pass:** Copilot Ingestion and the Financial Memory/Timeline remain
future phases. (ML Insights landed next — see "Phase 14" below.)

## Phase 14 — ML Insights

Genuinely real statistics computed in-process over the user's own data — **no call to
`AiGatewayService`/Groq anywhere in this module**. That's the point: the roadmap
explicitly didn't want "ML" that's actually just another LLM wrapper, and there's no
labeled outcome data anywhere in this app (no "did this user actually default / hit
their goal / overspend" ground truth) to train a real classifier against. What's
genuinely real here is that every model is a **named, textbook statistical method**,
documented as such, computed over real numbers pulled from `ExpensesService`/
`IncomeService`/`GoalsService`/`LoansService` — not a single opaque score. See
`apps/api/src/ai/ml-insights/`.

**What's built** — six models, each returning the same `ModelOutput<T>` shape
(`prediction`, `confidence`, `contributingFeatures`, `explanation`, and `method` so
it's never ambiguous what technique actually produced a number):

- **Anomaly detection** (`AnomalyDetectionModel`) — per-category median absolute
  deviation (MAD) with a modified z-score, the standard robust (outlier-resistant)
  technique, threshold |z| ≥ 3.5 (Iglewicz & Hoaglin, 1993's commonly cited cutoff).
  MAD instead of plain standard deviation specifically because a single huge outlier
  shouldn't inflate the very spread measure used to detect outliers.
- **Cashflow-stress forecast** (`CashflowForecastModel`) — ordinary least-squares
  linear regression (the actual formula, not an approximation) over the trailing
  monthly net-cashflow series, confidence = R² (how well a line actually fits the
  recent months, not a flat guess).
- **Debt risk scoring** (`DebtRiskModel`) — a weighted scorecard (EMI-to-income 50%,
  debt-to-income 30%, average interest rate 20%), the same normalize-then-weighted-sum
  structure real credit scorecards use. Explicitly documented as **hand-specified
  weights, not trained** — see the model's own doc comment for why.
- **Goal success likelihood** (`GoalSuccessModel`) — a continuous 0-1 probability via
  the logistic function over committed-vs-required monthly contribution ratio, a
  smoother companion to (not a replacement for) the existing ON_TRACK/AT_RISK/
  OFF_TRACK bucket.
- **Behavioral drift / trend-change detection** (`DriftDetectionModel`) — a real
  two-window (Welch's) z-test comparing the recent quarter's mean savings rate against
  the prior quarter's, significance threshold |z| ≥ 1.96 (~95% confidence under a
  normal approximation) — not just "is the latest number different from before".
- **Habit segmentation** (`HabitSegmentationModel`) — classifies each recent month
  into a behavioral state (high-saving / balanced / overspending) via a z-score
  against **the user's own trailing history**. Deliberately scoped as segmenting one
  user's behavior over time, not clustering across a population — this single-tenant-
  per-request app has no cross-user cohort data to support real clustering, and
  pretending otherwise would be exactly the kind of unlabeled "AI" the roadmap said
  not to ship.
- **Integration, exactly as the roadmap asked**: a new `MlInsightsPanel` on the
  Dashboard (`/dashboard`) surfaces these signals in their own card, explicitly
  labeled "Statistical signals (not rule-based)" — `DashboardService`'s existing
  deterministic `InsightList` is completely untouched. And Coach's `compare_periods`
  gatherer (Phase 12) now also runs `DriftDetectionModel` over a broader window as
  supplementary evidence — the concrete instance of "Coach uses ML outputs when
  explaining why this changed" the roadmap asked for; it augments the deterministic
  two-period diff, never replaces it as the source of the actual numbers.
- Tests: 15 for the pure math primitives (`linearRegression`, MAD, the two-window
  z-test, the logistic function) and 22 for the six models — 37 new tests, all
  Prisma-independent, **all passing in this sandbox** (unlike every prior AI phase's
  service-level tests). Writing the z-test primitive's tests caught one real,
  fixed-on-the-spot bug: two zero-variance windows with genuinely different means were
  returning z = 0 ("no difference") instead of the maximally significant result that
  situation actually represents — confirmed fixed by a clean rerun.

**Known limitations specific to this pass:**

- `DebtRiskModel`'s weights and `GoalSuccessModel`'s logistic steepness are
  hand-specified constants, not fitted to real outcomes — stated in both models' own
  code, not just here.
- `FeatureExtractionService.monthlySeries()` aggregates income by `receivedAt` as
  logged, not adjusted for `IncomeService`'s own recurrence/multiplier logic used
  elsewhere (e.g. `monthlyForecast`) — a deliberate scope simplification so this
  module's feature extraction stays a single, auditable pass over raw rows rather than
  re-deriving another service's projection logic.
- `AnomalyDetectionModel` and the monthly-series models are entirely independent
  passes over the same underlying `Expense`/`Income` tables — there's no shared
  caching between them or across repeated calls yet, so `GET /ml-insights/summary`
  does real work on every call rather than serving a cheap cached result.

**Not built in this pass:** the Financial Memory/Timeline remains a future phase.
(Copilot Ingestion landed next — see "Phase 15" below.)

## Phase 15 — Copilot Ingestion

A staged **review queue**, not a direct-write pipeline — nothing in this phase creates
an `Expense` row until a human explicitly approves an `IngestionReviewItem`. See
`apps/api/src/ai/copilot-ingestion/`.

**What's built:**

- **Statement parsing is deterministic first, AI second** (`statement-parser.ts` +
  `StatementUnderstandingService`). A real parser tries date/amount/merchant
  extraction against the common statement formats (ISO dates, DD/MM/YYYY, "15 Jan
  2026", ₹/Rs amounts with an optional Dr/Cr marker) — only the lines that don't
  clearly parse get sent to `AiGatewayService.extract()` as a fallback, and only those
  lines. A "Cr" (credit/refund) line is recognized and deliberately excluded — this
  pipeline imports expenses, not income.
- **Merchant normalization is deterministic first, too** (`merchant-normalization.ts`)
  — regex rules strip POS/UPI/NEFT/IMPS prefixes, trailing reference numbers, and
  masked card suffixes, so "POS AMAZON.IN 4829102" and "POS AMAZON.IN 5810293" both
  normalize to "Amazon.in" before any model is involved.
- **Category suggestion** (`CategorySuggestionService`) classifies against the exact
  list of the user's own existing categories via `AiGatewayService.classify()` — a
  closed label set, so it is structurally impossible for this to suggest a category
  that doesn't already exist in the account.
- **Duplicate detection** (`DuplicateDetectionService`) — pure, tiered comparison
  against existing `Expense` rows: exact tier (same normalized merchant, same day,
  amount within ₹0.50) at 95% confidence, near tier (±2 days, ±1% amount) at 60%,
  correctly distinguishing a likely re-import from a legitimate recurring charge that
  happens to look similar.
- **Recurring-pattern discovery reuses, rather than re-derives**, the existing
  `ExpensesService.detectSubscriptions()` — `RecurringDetectionService`'s only job is
  matching a fresh candidate against that already-trusted output, so ingestion review
  and the Subscriptions page can never disagree about what counts as recurring.
- **Anomaly flagging in imported data reuses Phase 14's `AnomalyDetectionModel`
  directly** — the same MAD/modified-z-score computation the Dashboard's
  `MlInsightsPanel` uses, applied here to a candidate transaction inserted alongside
  its suggested category's existing history. "Unusual amount" means the same thing
  everywhere in this app.
- **Confidence scoring is min-of-signals, not an average**
  (`SuggestionScoringService`) — a suggestion flagged as a likely duplicate or an
  anomaly gets capped to a low overall confidence regardless of how clean the category
  guess was, specifically so a strong category match can never mask a real duplicate/
  anomaly concern.
- **Human approval workflow with real conflict resolution**
  (`IngestionReviewService`) — approving an item flagged as a possible duplicate
  requires an explicit `duplicateResolution` ("kept_both" / "skipped_duplicate" /
  "merged"); the endpoint rejects the approval with a clear error otherwise. This is
  the literal "conflict resolution between model suggestions and existing manual
  data" the roadmap asked for — a required decision, not a silent heuristic.
  "merged" updates the existing (duplicate-of) expense in place via the same
  `ExpensesService.update()` every manual edit uses; "kept_both" creates a genuinely
  new `Expense` row; "skipped_duplicate" discards the suggestion entirely.
- **Frontend**: `/copilot-ingestion` — paste statement text + a label + a default
  payment method, get back a review queue grouped by import batch, each item showing
  its confidence badge, flags (possible duplicate / unusual amount / matches a
  subscription), missing fields, and an approve (with category + conflict-resolution
  pickers)/reject flow. Past imports are browsable from history.
- Tests: **29 new tests, all passing in this sandbox** (statement parsing — 8,
  merchant normalization — 7, duplicate/recurring/scoring — 12, anomaly-flagging reuse
  — 2) — none of this phase's core logic depends on a live Prisma client to test,
  following the same pattern Phase 14 established.

**Known limitations specific to this pass:**

- Payment method can't be reliably determined from typical statement text per
  transaction — it's always defaulted from the batch-level input and always disclosed
  as a missing/assumed field in `missingFields`, never silently guessed.
- A single `ingest()` call is capped at 200 lines (`MAX_LINES_PER_BATCH`) to bound
  per-line Groq category-suggestion calls — a longer statement needs to be split into
  smaller imports. Stated as a real scale limit, not hidden.
- The AI fallback for unparseable lines (`StatementUnderstandingService`) hasn't been
  exercised against real messy OCR output from this build environment, same live-call
  caveat as every other `AiGatewayService`-backed feature in this repo.
- No file-upload integration yet — ingestion takes pasted text, not a `Document`
  upload directly. Wiring `DocumentsService`'s existing OCR output straight into this
  pipeline is a natural fast-follow, not built this pass.

**Not built in this pass:** the Financial Memory/Timeline remains a future phase —
the last one from the original roadmap.

## What's built vs. what's next

**Built (runnable today)**
- Passwordless auth, sessions, device history, logout-all-devices, audit log
- User profile, household + dependents
- Income tracker, expense tracker (categories, breakdown, subscription detection)
- Investments, Loans & debt (amortization, prepayment calculator, snowball/avalanche)
- Insurance (coverage-gap analysis, nominee summary), Goals (feasibility heuristic)
- Tax planning (old vs. new regime), Retirement planner (corpus/SIP math)
- Alerts & notifications (renewals, EMIs, debt stress, goal delay, subscriptions,
  overspend, document expiry, business obligations — bell dropdown in the header)
- Settings (notifications, theme/language, data export, account deletion)
- Property portfolio, Business tracker (full CRUD incl. transactions/obligations),
  Document vault, Reports (monthly/yearly + CSV)
- Home dashboard: net worth (cash + investments + property − debt), cashflow, health
  score, rules-based insights, unread alert count
- Mobile-responsive nav (hamburger menu, scrollable Money sub-nav)
- AI Coach: 10 intents, every answer grounded in a live DB query, refusal for
  unmatched questions, insufficient-data handling for matched-but-unanswerable ones
- What-If Simulator: 9 scenario types, pure deterministic engine + real
  `SavedScenario` persistence + comparison view
- **Household-wide views**: net worth/cashflow/investments/property/debt/goals/business
  profit/alerts aggregation across members, role-scoped (OWNER sees per-member
  breakdown, MEMBER sees rollups only), shared-subscription detection flagging
- **Full edit/update UI**: every module with a backend `PATCH` route (Income, Expenses,
  Investments, Loans, Insurance, Goals, Property, Documents) now has a real inline edit
  form in the UI — not just create/delete. Shared via one reusable `InlineEditForm`
  component rather than 8 near-duplicate implementations.
- **What-If Simulator selectors**: loan/goal params are now populated dropdowns (e.g.
  "HDFC Bank — ₹3,50,000 outstanding"), not raw-ID text inputs.
- An initial Prisma migration (`packages/db/prisma/migrations/20260713000000_init/`)
  and a CI workflow (`.github/workflows/ci.yml`) that applies it to a real Postgres
  instance on every push.
- Seed data with realistic Indian numbers across every built module, including a
  second household member for the household feature
- **Portfolio rebalancer**: target-allocation vs. actual, with BUY/SELL/HOLD suggestions
  and optional new-cash deployment (Investments page)
- **Reusable rate limiting**: `@RateLimit()` + `RateLimitGuard`, applied to document
  upload; ready to reuse on future expensive routes
- **Subscription detection transparency**: confidence level + source expense IDs shown
  on the Subscriptions page, not just a bare merchant/amount list

**Not built yet (structured for, not stubbed)**
Native mobile app. The full AI/ML layer (see "Phase 9 — AI/ML roadmap" above). Alert
DSL / user-authored alert rules (deliberately deferred — see Phase 9). Joint/shared
asset ownership (e.g. a property owned by two spouses together) isn't a schema concept
yet — every financial entity belongs to exactly one `userId`, so a shared asset would
currently show under one person's name only; adding real joint ownership would need a
schema change (e.g. a join table or an ownership-share field), which is out of scope
for this pass.

**Known limitations worth knowing about**
- Document Vault's OCR is a deterministic mock (`MockOcrAdapter`) — no real text
  extraction happens yet. It's isolated behind an `OcrAdapter` interface specifically so
  swapping in a real adapter (e.g. Tesseract) later is a contained change; file storage
  itself is real, not mocked.
- **The full AI stack (Phases 10-15) is real, but Alerts (the deterministic rule
  engine itself) is still untouched, and every AI feature is additive to, never a
  replacement for, its deterministic foundation.** `AiGatewayService` + ops layer
  (Phase 10), AI Search (Phase 11, `/ai-search`), the Advanced tab on `/coach` (Phase
  12, `/coach/v2/*`), `/scenario-studio` (Phase 13), the Dashboard's
  `MlInsightsPanel` (Phase 14), and `/copilot-ingestion` (Phase 15) are real, working
  features — the original `/coach/ask` deterministic router (Phase 5),
  `SimulatorService` (Phase 5), `DashboardService`, `ExpensesService`, and
  `AlertsService` (Phase 9) are all untouched and remain the foundation everything
  downstream either uses directly, augments additively, or is verified against.
  `AlertsService`'s own rule engine remains deterministic and unchanged — ML Insights
  surfaces its signals in a separate, clearly-labeled Dashboard panel rather than
  being blended into it, and Copilot Ingestion never writes an `Expense` row without
  explicit human approval. Only the Financial Memory/Timeline (the last item on the
  original roadmap) remains unbuilt. See "Phase 10" through "Phase 15" above for
  exactly what each layer does and doesn't do yet, including self-reported-not-
  calibrated confidence scores (Phases 10-13, 15) vs. Phase 14's real statistical
  confidence (R², z-statistics), and the inability to verify live Groq/huggingface.co
  calls from this build environment.
- Seeded demo documents have placeholder `storageKey`s with no real backing file —
  downloading a *seeded* document returns a clean 404 (not a crash); uploading a real
  document through the UI works end to end.
- Business profit is intentionally not auto-injected into personal Income or the Tax
  estimate — a deliberate scope boundary to avoid double-counting, not an oversight.
- The Simulator's baseline model treats existing investments as compounding but idle
  monthly cash surplus as *not* auto-invested (0% return) unless a scenario explicitly
  redirects it — stated explicitly in every result's `assumptions` array so it's never
  hidden from the user.
- AI Coach's "why did X change" intent is deliberately unimplementable right now — this
  app doesn't persist periodic net-worth/spending snapshots, so there's no stored
  "before" state to diff against. It returns a grounded insufficient-data answer rather
  than fabricating one.
- No `SavedScenario` seed data — seeding it would require either duplicating the
  calculation engine inside the Prisma seed script or an awkward cross-package import
  into `apps/api/src`; saved scenarios start empty until a user runs and saves one.
- AI Coach and What-If Simulator remain per-user tools, not household-scoped — there's
  no existing product pattern for "shared AI coaching" or "household-wide what-if," and
  forcing one in would be speculative scope creep rather than a clean extension of what
  exists. The Household page aggregates unread alert counts across members, which is
  the one cross-cutting signal that already existed in a form worth summing.
- The initial Prisma migration was **hand-derived from schema.prisma**, not generated
  by the real Prisma CLI (this build environment has no network access to
  `binaries.prisma.sh`). CI applies it to a real Postgres instance on every push to
  catch any mistake in that derivation — see `DEPLOYMENT.md` for how to regenerate it
  with full certainty using the real engine.
- Four `AlertType` enum values that were declared but never implemented (`SIP_DUE`,
  `TAX_REMINDER`, `LOW_BALANCE`, `SAVINGS_MILESTONE`) were removed rather than
  backfilled with new heuristics under time pressure — they can come back once the
  underlying data model exists to ground them (e.g. a tax-deadline calendar).

## Tests

```bash
npm run --workspace=apps/api test    # 24 backend test files
npm run --workspace=apps/web test    # frontend: InlineEditForm + format utils + Business edit flow
npm run audit                         # schema/route/brace/JSON consistency checks
```

Backend coverage now includes **every core calculation service directly** (not just
indirectly through other modules' mocks): `LoansService` (amortization/prepayment
math), `InvestmentsService` (including the Phase 9 `rebalance()` allocation math),
`InsuranceService` (coverage-gap heuristic), `GoalsService` (feasibility heuristic),
`ExpensesService` (subscription detection with confidence scoring, category breakdown),
`IncomeService` (recurrence-based forecasting), `SettingsService`, `AuthService` (OTP
rate limiting, hashing, session issuance), `UsersService`, `HouseholdService`'s
dependent-management helpers, `BusinessService`'s update flows and ownership boundaries,
and the new reusable `RateLimitGuard` — on top of the existing coverage for dashboard
scoring, tax regime comparison, retirement math, the alerts engine, property valuation,
business P&L, document upload validation, report aggregation, the shared
financial-year/age utilities, AI Coach intent scoping/refusal, the What-If engine's
edge cases, and household permission boundaries.

Frontend coverage: `InlineEditForm` — the shared component behind every edit flow —
the shared money/percent formatting utilities, and (new this pass) a page-level test
for the Business edit flow, verifying a PATCH is issued instead of falling back to
delete+recreate.
