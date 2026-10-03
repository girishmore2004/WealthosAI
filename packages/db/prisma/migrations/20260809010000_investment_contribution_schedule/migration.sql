-- WealthOS AI — financial-core upgrade, phase 2: optional SIP / recurring-contribution
-- schedule on Investment. Purely additive: every column is nullable or defaulted, so all
-- existing investments keep behaving exactly as before (sipActive = false = no generation).
-- Hand-derived like the previous migrations; confirm with `prisma migrate dev` against a
-- real database before production use.

ALTER TABLE "Investment"
    ADD COLUMN "monthlyContribution" DECIMAL(14,2),
    ADD COLUMN "contributionDay" INTEGER,
    ADD COLUMN "contributionStartDate" TIMESTAMP(3),
    ADD COLUMN "contributionEndDate" TIMESTAMP(3),
    ADD COLUMN "sipActive" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Investment_sipActive_idx" ON "Investment"("sipActive");
