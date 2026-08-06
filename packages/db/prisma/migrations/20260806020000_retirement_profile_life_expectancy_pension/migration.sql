-- WealthOS AI — RetirementProfile: life expectancy and expected pension.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds the optional lifeExpectancyAge and expectedMonthlyPensionAtRetirement
-- columns to RetirementProfile (present in schema.prisma but missed by every earlier
-- migration). Both nullable with no default, so this is a purely additive,
-- backward-compatible migration — existing rows get NULL, meaning "use the flat
-- 25-year drawdown assumption" / "no guaranteed pension," identical to prior behavior.

ALTER TABLE "RetirementProfile"
    ADD COLUMN "lifeExpectancyAge" INTEGER,
    ADD COLUMN "expectedMonthlyPensionAtRetirement" DECIMAL(12,2);
