-- WealthOS AI — investment module upgrade: SIP lifecycle, installment outcomes and change history.
-- Purely additive and backward compatible: the new Investment columns are NULL on every existing row,
-- and the two new tables start empty, so existing schedules, contributions and totals are unchanged.
-- Hand-derived like the previous migrations; confirm with `prisma migrate dev` against a real
-- database before production use.

ALTER TABLE "Investment" ADD COLUMN "sipPausedAt" TIMESTAMP(3);
ALTER TABLE "Investment" ADD COLUMN "sipCancelledAt" TIMESTAMP(3);

CREATE TYPE "SipInstallmentStatus" AS ENUM ('PENDING', 'SKIPPED', 'FAILED');

CREATE TABLE "SipInstallmentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "status" "SipInstallmentStatus" NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SipInstallmentEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SipInstallmentEvent_investmentId_periodKey_key" ON "SipInstallmentEvent"("investmentId", "periodKey");
CREATE INDEX "SipInstallmentEvent_userId_investmentId_idx" ON "SipInstallmentEvent"("userId", "investmentId");

ALTER TABLE "SipInstallmentEvent" ADD CONSTRAINT "SipInstallmentEvent_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "InvestmentSipChange" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "investmentId" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "amountPerPeriod" DECIMAL(14,2) NOT NULL,
    "frequency" "Recurrence" NOT NULL DEFAULT 'MONTHLY',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvestmentSipChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvestmentSipChange_userId_investmentId_effectiveFrom_idx" ON "InvestmentSipChange"("userId", "investmentId", "effectiveFrom");

ALTER TABLE "InvestmentSipChange" ADD CONSTRAINT "InvestmentSipChange_investmentId_fkey" FOREIGN KEY ("investmentId") REFERENCES "Investment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
