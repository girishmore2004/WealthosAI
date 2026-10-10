-- WealthOS AI — money-flow phase 1, batch 5: recurrence rule snapshot + investment contribution
-- frequency. Purely additive and backward compatible:
--  * Expense.recurrenceTemplate is NULL on every existing row, so the generator keeps using the
--    row's own values exactly as today until a rule is explicitly edited.
--  * Investment.contributionFrequency defaults to 'MONTHLY', so every existing SIP schedule keeps
--    its monthly meaning and its "YYYY-MM" idempotency keys.
--  * Investment.expectedAnnualReturn is optional and used only by projections.
-- Hand-derived like the previous migrations; confirm with `prisma migrate dev` against a real
-- database before production use. Requires the previous migration (BIWEEKLY) to have run.

ALTER TABLE "Expense" ADD COLUMN "recurrenceTemplate" JSONB;

ALTER TABLE "Investment" ADD COLUMN "contributionFrequency" "Recurrence" NOT NULL DEFAULT 'MONTHLY';
ALTER TABLE "Investment" ADD COLUMN "expectedAnnualReturn" DECIMAL(6,3);
