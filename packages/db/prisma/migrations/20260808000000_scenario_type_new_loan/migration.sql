-- WealthOS AI — ScenarioType: add NEW_LOAN.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds NEW_LOAN to the ScenarioType enum (audit item #8 — "no scenario type
-- exists for a new/expansion loan distinct from prepayment," forcing such prompts into
-- LOAN_PREPAYMENT or HOUSE_PURCHASE). Purely additive: existing enum values and every
-- existing SavedScenario row referencing them are completely unaffected.
--
-- NOTE: PostgreSQL requires ALTER TYPE ... ADD VALUE to run outside an explicit
-- transaction block prior to PG 12; on PG 12+ (Prisma's supported baseline) this is
-- safe to run standalone, which is how Prisma's migration runner executes each
-- migration file already.

ALTER TYPE "ScenarioType" ADD VALUE 'NEW_LOAN';
