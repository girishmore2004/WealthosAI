-- WealthOS AI — ScenarioType: add EXPENSE_REDUCTION.
--
-- Purely additive. @wealthos/types, the Scenario Studio prompt parser and the intent
-- classifier already knew this value; the Prisma enum (and therefore the
-- simulator's @IsEnum DTO validation and SavedScenario persistence) did not.
-- IF NOT EXISTS makes the statement safe to re-run, same as the NEW_LOAN migration.

ALTER TYPE "ScenarioType" ADD VALUE IF NOT EXISTS 'EXPENSE_REDUCTION';
