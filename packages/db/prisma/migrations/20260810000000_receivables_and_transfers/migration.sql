-- WealthOS AI — money-flow phase 1, batch 2: receivables (money given that is expected back),
-- their repayment ledger, and internal account transfers. Purely additive: three new tables
-- and one new enum; no existing table or column is touched, so all current behavior is
-- unchanged. Hand-derived like the previous migrations; confirm with `prisma migrate dev`
-- against a real database before production use.

CREATE TYPE "ReceivableStatus" AS ENUM ('OUTSTANDING', 'PARTIALLY_RETURNED', 'FULLY_RETURNED', 'OVERDUE', 'CANCELLED');

CREATE TABLE "Receivable" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "person" TEXT NOT NULL,
    "purpose" TEXT,
    "originalAmount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "givenAt" TIMESTAMP(3) NOT NULL,
    "expectedReturnAt" TIMESTAMP(3),
    "status" "ReceivableStatus" NOT NULL DEFAULT 'OUTSTANDING',
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'UPI',
    "notes" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receivable_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReceivableRepayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "receivableId" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL,
    "paymentMethod" "PaymentMethod" NOT NULL DEFAULT 'UPI',
    "idempotencyKey" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceivableRepayment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountTransfer" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromAccount" TEXT NOT NULL,
    "toAccount" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "transferredAt" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountTransfer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Receivable_userId_status_idx" ON "Receivable"("userId", "status");
CREATE INDEX "Receivable_userId_givenAt_idx" ON "Receivable"("userId", "givenAt");
CREATE INDEX "Receivable_userId_expectedReturnAt_idx" ON "Receivable"("userId", "expectedReturnAt");

CREATE UNIQUE INDEX "ReceivableRepayment_idempotency_key" ON "ReceivableRepayment"("receivableId", "idempotencyKey");
CREATE INDEX "ReceivableRepayment_userId_returnedAt_idx" ON "ReceivableRepayment"("userId", "returnedAt");
CREATE INDEX "ReceivableRepayment_receivableId_idx" ON "ReceivableRepayment"("receivableId");

CREATE INDEX "AccountTransfer_userId_transferredAt_idx" ON "AccountTransfer"("userId", "transferredAt");

ALTER TABLE "Receivable" ADD CONSTRAINT "Receivable_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceivableRepayment" ADD CONSTRAINT "ReceivableRepayment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReceivableRepayment" ADD CONSTRAINT "ReceivableRepayment_receivableId_fkey" FOREIGN KEY ("receivableId") REFERENCES "Receivable"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "AccountTransfer" ADD CONSTRAINT "AccountTransfer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
