-- WealthOS AI — InsurancePolicy: optional link to a household Dependent as nominee.
--
-- Same provenance note as every prior migration in this repo: hand-derived from
-- schema.prisma without network access to the Prisma engine binary. Run
-- `npx prisma migrate dev` once against a real database with real network access to
-- confirm/correct this SQL before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: audit item #13 — "InsurancePolicy.nomineeName is a free-text string, not a
-- foreign key to Dependent, so there is no structural linkage between a policy's
-- nominee and the household's actual dependent records." Adds an OPTIONAL link
-- alongside (not replacing) the existing nomineeName column — every existing policy
-- gets NULL, meaning "not linked," identical to prior behavior. A policy naming a
-- non-household nominee (a friend, a charity, an institution with no Dependent row)
-- simply never sets this column, exactly as today.
--
-- ON DELETE SET NULL (not CASCADE): deleting a Dependent record must never delete the
-- insurance policy that named them as nominee — same soft-link pattern already used by
-- Property.loanId/Property.insurancePolicyId.

ALTER TABLE "InsurancePolicy"
    ADD COLUMN "nomineeDependentId" TEXT;

ALTER TABLE "InsurancePolicy"
    ADD CONSTRAINT "InsurancePolicy_nomineeDependentId_fkey"
    FOREIGN KEY ("nomineeDependentId") REFERENCES "Dependent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "InsurancePolicy_nomineeDependentId_idx" ON "InsurancePolicy"("nomineeDependentId");
