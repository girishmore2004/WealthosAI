-- WealthOS AI — money-flow phase 1, batch 7: emergency fund target / contribution plan and a
-- "reason" on ledger entries. Purely additive: one nullable column and one new table, so every
-- existing entry and every current balance is unchanged. Hand-derived like the previous
-- migrations; confirm with `prisma migrate dev` against a real database before production use.

ALTER TABLE "EmergencyFundEntry" ADD COLUMN "reason" TEXT;

CREATE TABLE "EmergencyFundPlan" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "targetAmount" DECIMAL(14,2),
    "targetMonths" DECIMAL(4,1),
    "monthlyContribution" DECIMAL(14,2),
    "targetDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EmergencyFundPlan_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "EmergencyFundPlan_userId_key" ON "EmergencyFundPlan"("userId");

ALTER TABLE "EmergencyFundPlan" ADD CONSTRAINT "EmergencyFundPlan_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
