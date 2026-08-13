-- WealthOS AI — opt-in Business drawing / Property rent -> Income sync links.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit items #9 and #10 — "no code path creates an Income row from
-- BusinessTransaction/OWNER_DRAWING" and "Property.monthlyRentalIncome never
-- auto-creates an Income row." Both columns are nullable with no default, so this is a
-- purely additive, backward-compatible migration — every existing row gets NULL,
-- meaning "not synced," identical to prior behavior (nothing auto-flowed into Income
-- before this change, and nothing does for existing rows after it either, until the
-- user explicitly opts in per-row/per-property).

ALTER TABLE "BusinessTransaction"
    ADD COLUMN "syncedIncomeId" TEXT;

ALTER TABLE "Property"
    ADD COLUMN "rentSyncedIncomeId" TEXT;
