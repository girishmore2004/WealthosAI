-- WealthOS AI — capital-gains realized-sale tracking (audit item #11).
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit item #11 — "Investments are not connected to capital-gains tax
-- calculations." Adds RealizedGainEvent, populated only by an explicit, user-initiated
-- "record a sale" action (InvestmentsService.recordSale()) — never auto-inferred from
-- Investment.currentValue changing, since a value drop could just be market movement,
-- not an actual disposal. Purely additive: no existing table or column is touched.

CREATE TABLE "RealizedGainEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "investmentType" "InvestmentType" NOT NULL,
    "saleDate" TIMESTAMP(3) NOT NULL,
    "proceeds" DECIMAL(14,2) NOT NULL,
    "costBasisPortion" DECIMAL(14,2) NOT NULL,
    "gainAmount" DECIMAL(14,2) NOT NULL,
    "holdingPeriodDays" INTEGER NOT NULL,
    "gainCategory" TEXT NOT NULL,
    "financialYear" TEXT NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RealizedGainEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RealizedGainEvent_userId_financialYear_idx" ON "RealizedGainEvent"("userId", "financialYear");
CREATE INDEX "RealizedGainEvent_investmentId_idx" ON "RealizedGainEvent"("investmentId");

ALTER TABLE "RealizedGainEvent"
    ADD CONSTRAINT "RealizedGainEvent_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RealizedGainEvent"
    ADD CONSTRAINT "RealizedGainEvent_investmentId_fkey"
    FOREIGN KEY ("investmentId") REFERENCES "Investment"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
