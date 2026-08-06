-- WealthOS AI — Goal: assumed annual return percent.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: adds the optional assumedAnnualReturnPercent column to Goal (present in
-- schema.prisma but missed by every earlier migration). Nullable with no default,
-- so this is a purely additive, backward-compatible migration — existing rows get
-- NULL, meaning "assume no growth," identical to prior behavior.

ALTER TABLE "Goal"
    ADD COLUMN "assumedAnnualReturnPercent" DECIMAL(5,2);
