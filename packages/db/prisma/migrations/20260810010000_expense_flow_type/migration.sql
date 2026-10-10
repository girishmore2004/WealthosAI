-- WealthOS AI — money-flow phase 1, batch 3: classify what kind of money movement an Expense
-- row is. Purely additive and backward compatible: the new column is NOT NULL with a default
-- of 'EXPENSE', so every existing row keeps behaving exactly as before (all history stays an
-- ordinary expense; nothing is reinterpreted). Adding a column with a constant default is a
-- metadata-only change on PostgreSQL 11+. Hand-derived like the previous migrations; confirm
-- with `prisma migrate dev` against a real database before production use.

CREATE TYPE "ExpenseFlowType" AS ENUM ('EXPENSE', 'OTHER_OUTFLOW');

ALTER TABLE "Expense" ADD COLUMN "flowType" "ExpenseFlowType" NOT NULL DEFAULT 'EXPENSE';

-- Serves the spending-analytics queries (per user, per flow, by date) and the category
-- drill-down (per user, per category, by date) without scanning the whole table.
CREATE INDEX "Expense_userId_flowType_spentAt_idx" ON "Expense"("userId", "flowType", "spentAt");
CREATE INDEX "Expense_userId_categoryId_spentAt_idx" ON "Expense"("userId", "categoryId", "spentAt");
