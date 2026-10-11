-- LoanPayment: one row per recorded EMI (loan, period). The model existed in schema.prisma
-- but no earlier migration created its table. Written to be safe to run more than once.

CREATE TABLE IF NOT EXISTS "LoanPayment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "interestPortion" DECIMAL(14,2) NOT NULL,
    "principalPortion" DECIMAL(14,2) NOT NULL,
    "outstandingBefore" DECIMAL(14,2) NOT NULL,
    "outstandingAfter" DECIMAL(14,2) NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoanPayment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "LoanPayment_idempotency_key" ON "LoanPayment"("loanId", "period");
CREATE INDEX IF NOT EXISTS "LoanPayment_userId_paidAt_idx" ON "LoanPayment"("userId", "paidAt");

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanPayment_userId_fkey') THEN
        ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_userId_fkey"
            FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'LoanPayment_loanId_fkey') THEN
        ALTER TABLE "LoanPayment" ADD CONSTRAINT "LoanPayment_loanId_fkey"
            FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
