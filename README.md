# WealthOS AI

**WealthOS AI** is an India-first, AI-powered personal wealth operating system. It
brings daily spending, savings, investments, loans, insurance, tax, retirement,
property, business finances, documents, and household-wide money management into a
single connected platform — with an AI layer (retrieval-augmented search, an agentic
Coach, ML-based insights, statement Copilot ingestion, and a Scenario Studio) built on
top of a deterministic, explainable financial core.

Every number the AI layer talks about is grounded in real computation from the
platform's own services, never invented. See [Architecture](#architecture) for how the
deterministic and AI layers are kept separate and verifiable.

> **Disclaimer**: WealthOS AI provides projections and explainable, rules-based
> insights based on the data you enter. It is not financial, tax, or legal advice, and
> nothing in this product guarantees future outcomes.

---

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Monorepo structure](#monorepo-structure)
- [Features](#features)
- [Local development setup](#local-development-setup)
- [Deployment](#deployment)
- [AI features configuration](#ai-features-configuration)
- [Database and migrations](#database-and-migrations)
- [Testing and quality](#testing-and-quality)
- [Security and privacy](#security-and-privacy)
- [Contributing and project notes](#contributing-and-project-notes)

---

## Overview

WealthOS AI is built for individuals and households in India who want one place to
track and plan their entire financial life — not a single-purpose budgeting app, but a
full "money OS":

- **Money modules**: income, expenses, investments, loans/debt, insurance, property,
  business finances, goals, retirement, tax planning, and a document vault.
- **Planning & analytics**: a net-worth/health-score dashboard, monthly/yearly reports,
  a rules-based alerts engine, and a What-If Simulator for scenario planning.
- **Household finance**: multiple household members with role-scoped visibility
  (owners see per-member breakdowns, members see aggregate rollups).
- **AI features**, layered on top of the deterministic core rather than replacing it:
  - **RAG-powered AI Search** over your own documents, reports, and financial history.
  - **Agentic Coach** — plans, verifies, and explains answers to financial questions,
    with every number traced back to a deterministic calculation.
  - **ML Insights** — real statistical models (regression, MAD-based anomaly
    detection, logistic scoring, z-tests) over your own data, not a black-box score.
  - **Copilot Ingestion** — turns pasted bank/card statement text into a reviewable
    queue of categorized expense suggestions; nothing is written until you approve it.
  - **Scenario Studio** — natural-language "what if" questions turned into ranked,
    explained simulator runs.

**Target users**: individuals and families in India managing money across multiple
accounts, asset classes, and financial goals, plus developers who want a reference
implementation of a full-stack, India-specific fintech-style product with a real
(not decorative) AI layer.

---

## Architecture

### High-level flow

```
┌─────────────────┐      HTTPS (fetch, credentials: include)      ┌──────────────────────┐
│  apps/web        │ ───────────────────────────────────────────► │  apps/api             │
│  Next.js 14       │                                               │  NestJS (Express)     │
│  App Router        │ ◄─────────────────────────────────────────  │                        │
│  React + Tailwind │        JSON responses, httpOnly session cookie│  REST controllers      │
└─────────────────┘                                               └──────────┬───────────┘
                                                                              │
                                    ┌─────────────────────────────────────────┼─────────────────────────┐
                                    │                                         │                         │
                                    ▼                                         ▼                         ▼
                         ┌───────────────────┐                    ┌───────────────────┐     ┌───────────────────────┐
                         │  PostgreSQL         │                    │  Redis              │     │  AI layer (apps/api/src/ai) │
                         │  via Prisma (packages/db) │              │  sessions, rate      │     │  Gateway → Groq API    │
                         │  source of truth     │                    │  limits, AI cache,   │     │  local embeddings       │
                         │                      │                    │  BullMQ queue        │     │  (Xenova/transformers)  │
                         └───────────────────┘                    └───────────────────┘     └───────────────────────┘
```

- **Frontend → Backend**: the Next.js app calls the NestJS API over HTTPS using
  `NEXT_PUBLIC_API_URL` (see `apps/web/lib/api-client.ts`); the session lives in an
  httpOnly cookie, so no token handling in client code.
- **Backend → Database**: every domain module (income, expenses, investments, etc.)
  is a NestJS module with its own controller/service, reading and writing through the
  shared Prisma client in `packages/db`.
- **Backend → Redis**: sessions, OTP rate limiting, the generic `RateLimitGuard`, the
  AI response cache, and the BullMQ job queue all share one Redis instance.
- **Backend → AI layer**: AI features never call Groq directly from a domain
  controller. Everything funnels through `AiGatewayService`, which handles
  redaction, token budgeting, prompt versioning, model routing, JSON-schema
  validation, and interaction logging in one place.

### Why this stack

| Layer | Technology | Why |
|---|---|---|
| Frontend | Next.js 14 (App Router) + TypeScript + Tailwind CSS | File-based routing, server/client component split, fast iteration, no separate design-system dependency. |
| Backend | NestJS (Express adapter) + TypeScript | Modular, dependency-injected architecture that scales cleanly to 20+ domain modules without becoming a single giant Express app. |
| Database | PostgreSQL + Prisma ORM | Relational integrity for financial data (foreign keys, transactions), type-safe query layer shared by API and seed scripts. |
| Cache / queue | Redis + BullMQ | One instance covers sessions, rate limiting, AI response caching, and background job processing (OCR-adjacent work, AI jobs) without extra infrastructure. |
| AI inference | Groq (OpenAI-compatible API), Llama 3.x models | Free-tier hosted inference for open-source models — no self-hosted GPU required, while keeping the interface swappable. |
| Embeddings | `@xenova/transformers` (`all-MiniLM-L6-v2`, WASM, CPU) | Cheap enough to run in-process for RAG, avoiding a paid embeddings API for a lightweight, per-user document corpus. |
| Monorepo | npm workspaces | Shared Prisma client and DTO types (`packages/db`, `packages/types`) consumed by both `apps/api` and `apps/web` without publishing internal packages. |

**Design principle — deterministic core, AI as an explanation layer**: every
financial calculation (net worth, amortization, tax regime comparison, retirement
corpus, goal feasibility, simulator projections) is computed by plain TypeScript
services with no model call involved. The AI layer (RAG, Coach, ML Insights, Scenario
Studio, Copilot Ingestion) reads from and explains that deterministic output — it does
not replace it. Where an AI-composed answer would introduce a number that cannot be
traced back to something already computed, it is discarded and the raw computed facts
are returned instead. This is enforced in code (e.g. `NumericConsistencyVerifier`), not
just prompted for.

---

## Monorepo structure

```
wealthos-ai/
├── apps/
│   ├── api/                    NestJS backend
│   │   ├── src/
│   │   │   ├── auth/             passwordless OTP auth, sessions
│   │   │   ├── users/            user profile
│   │   │   ├── household/        household + dependents, aggregation
│   │   │   ├── income/           income tracking & forecasting
│   │   │   ├── expenses/         expense tracking, categories, subscriptions
│   │   │   ├── investments/      portfolio tracking, rebalancer
│   │   │   ├── loans/            amortization, prepayment, snowball/avalanche
│   │   │   ├── insurance/        coverage-gap analysis
│   │   │   ├── goals/            goal feasibility
│   │   │   ├── tax/              old vs. new regime comparison
│   │   │   ├── retirement/       corpus / SIP planning
│   │   │   ├── alerts/           deterministic rules-based alerts engine
│   │   │   ├── settings/         notification/theme/export/account settings
│   │   │   ├── property/         property portfolio
│   │   │   ├── business/         business P&L, transactions, obligations
│   │   │   ├── documents/        document vault (storage + OCR adapters)
│   │   │   ├── reports/          monthly/yearly reports, CSV export
│   │   │   ├── dashboard/        net worth, health score, insights
│   │   │   ├── simulator/        What-If Simulator engine + persistence
│   │   │   ├── coach/            deterministic AI Coach (intent router)
│   │   │   ├── ai/               AI layer: gateway, rag, coach (agentic),
│   │   │   │                     scenario-studio, ml-insights, copilot-ingestion
│   │   │   ├── redis/            Redis client provider
│   │   │   ├── common/           shared guards, filters, interceptors
│   │   │   ├── config/           environment configuration
│   │   │   └── main.ts           app bootstrap, CORS, cookies, validation
│   │   ├── storage/documents/    local (gitignored) document storage
│   │   └── test/                 Jest unit/integration test suites
│   └── web/                     Next.js 14 App Router frontend
│       ├── app/                   routed pages (dashboard, money/*, coach,
│       │                          ai-search, scenario-studio, copilot-ingestion,
│       │                          reports, settings, household, login, onboarding)
│       ├── components/            shared UI components
│       └── lib/                   API client, formatting utilities
├── packages/
│   ├── db/                     Prisma schema, migrations, seed data, shared client
│   └── types/                  Shared TypeScript DTOs used by both apps
├── scripts/audit.sh            Consistency audit (schema, routes, braces, JSON)
├── docker-compose.yml           Local Postgres + Redis (free, self-hosted)
├── .github/workflows/ci.yml     CI: audit, tests, builds, real migration apply
├── DEPLOYMENT.md                 Step-by-step Render + Vercel deployment guide
└── package.json                  npm workspaces root
```

`apps/api` and `apps/web` each depend on `@wealthos/db` (Prisma client + types) and
`@wealthos/types` (shared DTOs) as workspace packages — build those first when
building either app standalone (see [Local development setup](#local-development-setup)).

---

## Features

### Auth
- **Passwordless email OTP** — no passwords stored anywhere. A one-time code is
  issued, rate-limited, and verified server-side; a session is then created as an
  httpOnly cookie backed by Redis + a Postgres `Session` row.
- Device/session history, "log out of all devices", and an audit log of security
  events.

### Money modules
- **Income** — recurring and one-off income tracking with forecasting.
- **Expenses** — categorized spending, breakdowns, and merchant-based subscription
  detection with confidence scoring.
- **Investments** — portfolio tracking across asset types, plus a target-allocation
  rebalancer that suggests BUY/SELL/HOLD actions.
- **Loans** — amortization schedules, prepayment calculators, snowball/avalanche
  payoff strategies.
- **Insurance** — policy tracking with a coverage-gap analysis and nominee summary.
- **Goals** — savings goals with a feasibility heuristic (on-track / at-risk /
  off-track).
- **Retirement** — corpus and SIP planning based on stated assumptions.
- **Tax planning** — old vs. new Indian income tax regime comparison.
- **Property** — a property portfolio with valuation tracking.
- **Business** — a business tracker with transactions and recurring obligations,
  kept separate from personal income to avoid double-counting.
- **Household** — multiple members per household with role-based visibility (owners
  see per-member detail, members see aggregate rollups only).
- **Documents** — a document vault with pluggable storage and OCR adapters.

### Planning & analytics
- **Dashboard** — net worth (cash + investments + property − debt), cashflow, a
  rules-based financial health score, and deterministic insights.
- **Reports** — server-computed monthly/yearly summaries with CSV export.
- **Alerts** — a deterministic, explainable rules engine covering renewals, EMIs,
  debt stress, goal delays, subscriptions, overspending, document expiry, and
  business obligations.
- **What-If Simulator** — a pure calculation engine (no DB access) covering multiple
  scenario types (SIP increases, loan prepayment, retirement-age shifts, house
  purchase, and more), with real persistence of saved scenarios.

### AI features
All AI features route through a single **AI Gateway** and are additive to, never a
replacement for, the deterministic modules above.

- **AI Gateway** (`apps/api/src/ai/gateway`) — the one place in the codebase that
  talks to a language model. Handles PII redaction, token budgeting, prompt
  versioning, model routing (small vs. large model by task type), JSON-schema
  response validation with retry, and interaction logging.
- **RAG Search** (`apps/api/src/ai/rag`) — indexes a user's own documents, reports,
  coach history, and financial snapshot into locally computed embeddings; hybrid
  (semantic + keyword + recency + source-priority) retrieval; reranking; and
  citation-aware answer synthesis that refuses to answer when evidence is weak.
- **Agentic Coach** (`apps/api/src/ai/coach`) — a planning/execution/verification
  pipeline layered over the original deterministic intent router. Numeric claims in
  composed answers are verified against already-computed facts before being shown;
  anything that doesn't check out falls back to the raw facts.
- **ML Insights** (`apps/api/src/ai/ml-insights`) — real, named statistical models
  (linear regression, MAD-based anomaly detection, a weighted debt-risk scorecard,
  logistic goal-success scoring, two-window z-tests for behavioral drift) computed
  over the user's own data — no language model call in this module.
- **Copilot Ingestion** (`apps/api/src/ai/copilot-ingestion`) — turns pasted
  statement text into a reviewable queue: deterministic parsing first, AI fallback
  only for lines that don't parse cleanly, duplicate/anomaly/recurring-charge
  detection, and a human approval step before anything is written as an `Expense`.
- **Scenario Studio** (`apps/api/src/ai/scenario-studio`) — parses natural-language
  "what if" prompts into Simulator parameters, expands them into best/base/worst/
  constrained variants and a sensitivity analysis, ranks them, and explains the
  result — all numbers come from re-running the same deterministic Simulator engine.

---

## Local development setup

### Prerequisites

- **Node.js 20+**
- **npm** (this repo uses npm workspaces — not yarn/pnpm)
- **Docker** (for local Postgres + Redis via `docker-compose.yml`), or your own
  reachable Postgres and Redis instances

### Setup

```bash
# 1. Clone the repo
git clone https://github.com/<your-username>/wealthos-ai.git
cd wealthos-ai

# 2. Install dependencies (installs all workspaces)
npm install

# 3. Start local infra (free, self-hosted Postgres + Redis)
docker compose up -d

# 4. Configure environment variables
cp .env.example .env
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env

# 5. Generate the Prisma client, run migrations, and seed the database
npm run db:generate
npm run db:migrate
npm run db:seed

# 6. Run backend and frontend (in separate terminals)
npm run dev:api    # http://localhost:4000
npm run dev:web    # http://localhost:3000
```

### Example `.env` (root / `apps/api/.env`)

```bash
DATABASE_URL="postgresql://wealthos:wealthos_dev_password@localhost:5432/wealthos?schema=public"
REDIS_URL="redis://localhost:6379"
SESSION_TTL_SECONDS=2592000
API_PORT=4000
WEB_URL="http://localhost:3000"
CORS_EXTRA_ORIGINS=""
VERCEL_PREVIEW_PREFIX=""
CROSS_SITE_COOKIES=""
OTP_ADAPTER=mock
RESEND_API_KEY=""
OTP_FROM_EMAIL="WealthOS AI <onboarding@resend.dev>"
NODE_ENV=development

# AI Gateway
GROQ_API_KEY=""
GROQ_API_BASE_URL="https://api.groq.com/openai/v1"
GROQ_SMALL_MODEL="llama-3.1-8b-instant"
GROQ_LARGE_MODEL="llama-3.3-70b-versatile"
AI_REQUEST_TIMEOUT_MS=20000
AI_MAX_RETRIES=2
AI_CACHE_TTL_SECONDS=900
```

### Example `.env` (`apps/web/.env`)

```bash
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### Notes

- **OTP delivery is mocked by default** (`OTP_ADAPTER=mock`) — login codes are logged
  to the API terminal instead of sent by email, so no email provider is required for
  local development. Watch the `dev:api` terminal for a line like:
  ```
  [DEV ONLY] OTP for demo@wealthos.ai: 482913
  ```
  Set `OTP_ADAPTER=resend` with a `RESEND_API_KEY` and a verified `OTP_FROM_EMAIL` to
  send real emails.
- **Demo login**: `demo@wealthos.ai` (household owner). A second seeded member,
  `demo-member@wealthos.ai`, demonstrates the owner-vs-member household view.
- **AI features require `GROQ_API_KEY`** (a free key from
  [console.groq.com](https://console.groq.com)). Leaving it unset does not crash the
  app — `AiGatewayService` throws a handled "AI unavailable" error on any AI call
  instead.
- **Uploaded documents** are written to `apps/api/storage/documents/` by default
  (override with `DOCUMENT_STORAGE_PATH`). This directory is gitignored.
- The database schema and app assume **Indian tax years, currency (₹), and tax
  slabs** — this is not a general-purpose/multi-currency personal finance tool.

---

## Deployment

This is a summary — see [`DEPLOYMENT.md`](./DEPLOYMENT.md) for the full step-by-step
guide (including a post-deploy smoke test and a release checklist).

### Backend (e.g. Render)

1. Create a Postgres instance and a Redis instance (e.g. [Neon](https://neon.tech) /
   [Upstash](https://upstash.com), or Render's own add-ons).
2. Deploy `apps/api` as a Node web service:
   - **Root directory**: repo root (workspaces need to resolve `packages/db` and
     `packages/types`).
   - **Build command**: `npm install && npm run db:generate && npm run db:migrate:deploy && npm run build:api`
   - **Start command**: `node apps/api/dist/main.js`
3. Set environment variables: `DATABASE_URL`, `REDIS_URL`, `SESSION_TTL_SECONDS`,
   `API_PORT`, `WEB_URL` (your frontend URL), `CORS_EXTRA_ORIGINS`,
   `VERCEL_PREVIEW_PREFIX`, `CROSS_SITE_COOKIES`, `OTP_ADAPTER` (+ `RESEND_API_KEY` /
   `OTP_FROM_EMAIL` if using `resend`), `NODE_ENV=production`, and the AI Gateway
   variables if AI features are enabled.
4. Note: most PaaS providers inject their own `PORT` — `apps/api/src/main.ts` already
   prefers `process.env.PORT` over `API_PORT` when present.
5. Free-tier filesystems are typically **ephemeral** — document uploads will not
   survive a redeploy unless you attach persistent storage or swap in an
   S3-compatible `DocumentStorageAdapter`.

### Frontend (e.g. Vercel)

1. Import the repo with **root directory** set to `apps/web`.
2. **Build command**: `cd ../.. && npm install && npm run build:packages && cd apps/web && npm run build`
   (the frontend depends on the workspace packages, which must be built first even
   though Vercel's root directory is `apps/web`).
3. Environment variable: `NEXT_PUBLIC_API_URL` = your backend's public URL.
4. After the first deploy, set the backend's `WEB_URL` to your Vercel URL and
   redeploy the backend so CORS allows it.

### Cross-origin considerations

Backend and frontend typically live on different domains (e.g. `*.onrender.com` and
`*.vercel.app`), which makes every API call a **cross-site** request from the
browser's perspective:

- Session cookies need `SameSite=None; Secure` to survive this — `CROSS_SITE_COOKIES`
  defaults to `true` whenever `NODE_ENV=production`, so this normally needs no
  manual configuration.
- CORS only allows the exact `WEB_URL` origin by default. Set
  `CORS_EXTRA_ORIGINS` (comma-separated) for additional origins, or
  `VERCEL_PREVIEW_PREFIX` to allow Vercel's per-branch preview URLs through.
- If login "doesn't stick" after a page reload, this is almost always a cross-site
  cookie or CORS origin mismatch — see the smoke-test steps in `DEPLOYMENT.md`.

---

## AI features configuration

AI features (RAG Search, Agentic Coach, Scenario Studio, Copilot Ingestion) are
powered by **Groq**, which serves open-source models (Llama 3.1 / 3.3) over an
OpenAI-compatible HTTP API. Embeddings for RAG are computed **locally** via
`@xenova/transformers`, not through Groq.

### Environment variables

```bash
GROQ_API_KEY=""                                    # from console.groq.com
GROQ_API_BASE_URL="https://api.groq.com/openai/v1"
GROQ_SMALL_MODEL="llama-3.1-8b-instant"             # classification, extraction, ranking
GROQ_LARGE_MODEL="llama-3.3-70b-versatile"          # generation, summarization
AI_REQUEST_TIMEOUT_MS=20000
AI_MAX_RETRIES=2
AI_CACHE_TTL_SECONDS=900
```

### Cost control, caching, and fallbacks

- **Model routing**: cheap, fast tasks (classification, extraction, ranking) use the
  small model; generation/summarization tasks route to the large model, kept as one
  policy in `ModelRouterService` rather than scattered per feature.
- **Response caching**: cacheable task types are cached in Redis
  (`AiCacheService`, TTL via `AI_CACHE_TTL_SECONDS`) to avoid repeat calls for
  identical inputs.
- **Redaction before send**: free-text inputs are passed through `RedactionService`
  (email/phone/PAN/Aadhaar/card-shaped patterns) before leaving the process.
- **Token budgeting**: `TokenBudgetService` trims input to a configured budget before
  a call is made.
- **Schema validation with retry**: model responses are validated against the
  caller's expected schema, with a bounded number of correction retries
  (`AI_MAX_RETRIES`) before falling back to a safe default.
- **Graceful degradation**: every AI-backed feature has a defined fallback if the
  model call fails or `GROQ_API_KEY` is unset — deterministic paths (Coach's original
  intent router, the Simulator engine, ML Insights' statistical models) continue to
  work without any AI configuration at all.
- **Interaction logging**: every AI Gateway call is logged (`AiInteractionLog`) for
  auditability, independent of whether it succeeded.

---

## Database and migrations

The schema is defined in `packages/db/prisma/schema.prisma` and managed with Prisma
Migrate. Migrations live in `packages/db/prisma/migrations/`.

### Common commands

```bash
# Generate the Prisma client (run after cloning or changing the schema)
npm run db:generate

# Apply migrations in local development (creates a new migration if the schema changed)
npm run db:migrate

# Apply already-committed migrations (used in CI / production deploys)
npm run db:migrate:deploy

# Seed the database with demo data
npm run db:seed

# Browse the database visually
cd packages/db && npx prisma studio
```

### Resetting the database

```bash
cd packages/db
npx prisma migrate reset   # drops, recreates, re-migrates, and re-seeds
```

### Major schema areas

- **Identity & household**: `User`, `Household`, `HouseholdInvite`, `Dependent`,
  `Session`, `OtpCode`, `AuditLog`.
- **Core money modules**: `Income`, `Expense`, `Category`, `Budget`, `Investment`,
  `Loan`, `InsurancePolicy`, `Goal`, `TaxDeduction`, `RetirementProfile`, `Property`,
  `Business`, `BusinessTransaction`, `BusinessObligation`, `Document`.
- **Planning**: `Alert`, `UserSettings`, `SavedScenario`.
- **AI layer**: `AiInteractionLog`, `AiPromptVersion`, `AiJob`, `AiEmbeddingChunk`,
  `AiSourceIndexState`, `AiSearchLog`, `AgenticCoachRun`, `CoachFinancialMemory`,
  `CoachPlan`, `CoachPlanStep`, `CoachTask`, `CoachProgressSnapshot`, `CoachNudge`,
  `CoachInteraction`, `MlInsightRun`, `IngestionBatch`, `IngestionReviewItem`,
  `MerchantCategoryMemory`, `MerchantCategoryGlobalStat`,
  `SuggestionRankingProfile`, `ScenarioStudioRun`, `ScenarioMonteCarloRun`,
  `ScenarioOptimizationRun`.

Every financial record is scoped to exactly one `userId` — there is no shared/joint
ownership model for assets yet (see [Known limitations](#known-limitations)).

> **Note**: the initial migration
> (`20260713000000_init`) was originally hand-derived from `schema.prisma` in an
> environment without network access to Prisma's binary host, rather than generated
> by the Prisma CLI. CI (`migration-check` job in `.github/workflows/ci.yml`) applies
> it to a real Postgres instance on every push to catch drift. If you want full
> certainty before a first production deploy, you can regenerate it yourself with
> real network access — see `DEPLOYMENT.md`, step 3.

---

## Testing and quality

```bash
# Backend test suite (Jest)
npm run --workspace=apps/api test

# Frontend test suite (Jest + Testing Library)
npm run --workspace=apps/web test

# Consistency audit — duplicate Prisma models, brace balance, JSON validity,
# and best-effort route parity between the frontend API client and backend controllers
npm run audit

# Lint (all workspaces, where configured)
npm run lint

# Format
npm run format
```

CI (`.github/workflows/ci.yml`) runs the audit, backend tests, both app builds, and a
separate job that applies the initial migration to a real Postgres service container,
on every push/PR to `main`.

### Basic QA checklist for major features

- [ ] Login with a fresh email → OTP appears in server logs (or inbox, if
      `OTP_ADAPTER=resend`) → session persists across a page reload.
- [ ] Dashboard shows net worth, health score, and insights for the seeded demo user.
- [ ] Create/edit/delete a record in at least one money module (e.g. Expenses) and
      confirm the change reflects on the Dashboard/Reports.
- [ ] Household: log in as `demo-member@wealthos.ai` and confirm the member-scoped
      (rollup-only) view differs from the owner view.
- [ ] Run the What-If Simulator with at least one scenario type and confirm a saved
      scenario appears in comparison view.
- [ ] With `GROQ_API_KEY` set: run `POST /ai/health/self-test`, then AI Search, Coach
      (Advanced tab), Scenario Studio, and Copilot Ingestion each produce a response
      without an unhandled error.
- [ ] Without `GROQ_API_KEY` set: confirm the app still boots and non-AI features work
      normally.

---

## Security and privacy

- **Authentication**: passwordless, email-based one-time codes. No password hashes to
  leak because no passwords are stored. Sessions are httpOnly cookies backed by
  Redis + a Postgres `Session` record, with configurable TTL (`SESSION_TTL_SECONDS`)
  and a "log out of all devices" flow.
- **Ownership-scoped access**: financial records are always read/written scoped to
  the requesting user's `userId` (or household membership for household views) —
  never by a client-supplied identifier alone.
- **Rate limiting**: a reusable, Redis-backed `RateLimitGuard`
  (`@RateLimit(limit, windowSeconds)`) is applied to OTP issuance and to the most
  expensive routes (e.g. document upload, which triggers OCR inline).
- **CORS**: an explicit origin allowlist (`WEB_URL` + `CORS_EXTRA_ORIGINS`, with an
  opt-in Vercel-preview-URL pattern match) — no wildcard origins in production.
- **PII redaction for AI calls**: free-text sent to the AI Gateway is passed through
  `RedactionService`, which strips email/phone/PAN/Aadhaar/card-shaped substrings
  before the call is made. Structured context assembled from the database (amounts,
  names already known to the account) is not redacted, since redacting it would break
  grounding without a corresponding safety benefit for data the user already owns.
- **Document storage**: uploaded files are stored under an opaque, server-generated
  UUID key (never a client-supplied path) behind a swappable
  `DocumentStorageAdapter` interface — local disk by default, S3-compatible storage
  can be substituted without touching business logic.
- **AI interaction logging**: every AI Gateway call is logged
  (`AiInteractionLog`) for auditability — including calls that failed or were
  refused — and every Coach interaction (including refusals) is logged to
  `CoachInteraction`/`AgenticCoachRun`.
- **Human-in-the-loop for AI-suggested writes**: Copilot Ingestion never creates an
  `Expense` row automatically — every AI-suggested transaction sits in a review queue
  until a person explicitly approves it, including an explicit conflict-resolution
  choice for suspected duplicates.

---

## Contributing and project notes

### Branching and PRs

- Branch from `main`, open a PR against `main`. CI must pass (audit, backend tests,
  both builds, and the migration-apply check) before merging.
- If your change touches `packages/db/prisma/schema.prisma`, generate and commit a
  real migration (`cd packages/db && npx prisma migrate dev --name <description>`)
  rather than editing `schema.prisma` alone.
- Run `npm run format` and `npm run lint` before opening a PR.

### Module boundaries

- Each domain (income, expenses, loans, etc.) is a self-contained NestJS module with
  its own controller, service, and DTOs — cross-module reads happen through a
  service's public methods, not direct Prisma queries reaching into another module's
  concern.
- All AI features route through `AiGatewayService` — no domain or AI submodule should
  call the Groq API directly.
- Shared types used by both `apps/api` and `apps/web` belong in `packages/types`, not
  duplicated in each app.

### Known limitations

- Document OCR uses a pluggable `OcrAdapter` interface; swapping in a production-grade
  OCR provider is a contained change behind that interface.
- No joint/shared asset ownership model yet — every financial record belongs to
  exactly one user, so a jointly owned asset currently shows under one person only.
- No periodic financial snapshot history — "how did my net worth change over time"
  style questions are limited to what can be computed from current data plus whatever
  a given module already stores, not a true historical time series.
- AI Gateway confidence scores are self-reported by the model, not statistically
  calibrated (with the exception of ML Insights, which reports real statistical
  measures such as R² and z-scores).
- See [`DEPLOYMENT.md`](./DEPLOYMENT.md) for deployment-specific caveats (ephemeral
  free-tier filesystems, the hand-derived initial migration note, etc.).

### License

MIT — see [`LICENSE`](./LICENSE).
