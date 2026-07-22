-- WealthOS AI — Phase 9 migration.
--
-- Same provenance note as the initial migration: hand-derived from schema.prisma
-- without network access to the Prisma engine binary. Run `npx prisma migrate dev`
-- once against a real database with real network access to confirm/correct this SQL
-- before relying on it in production. See DEPLOYMENT.md.
--
-- Purpose: bring Business up to full CRUD parity (adds the fields an "edit business"
-- form needs — entity type, currency, start date, ownership %) and gives
-- BusinessObligation a vendor + status so obligations can be tracked through their
-- lifecycle instead of only created/deleted. No new tables — additive columns only,
-- all nullable or defaulted, so this is a safe migration against existing data.

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE "BusinessEntityType" AS ENUM ('SOLE_PROPRIETORSHIP', 'PARTNERSHIP', 'LLP', 'PRIVATE_LIMITED', 'OTHER');
CREATE TYPE "ObligationStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'CANCELLED');

-- ============================================================================
-- Business — add entity metadata, currency, start date, ownership %, updatedAt
-- ============================================================================

ALTER TABLE "Business" ADD COLUMN "entityType" "BusinessEntityType" NOT NULL DEFAULT 'SOLE_PROPRIETORSHIP';
ALTER TABLE "Business" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'INR';
ALTER TABLE "Business" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "Business" ADD COLUMN "ownershipPercent" DECIMAL(5,2);
ALTER TABLE "Business" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================================================
-- BusinessTransaction — add updatedAt (now editable via PATCH)
-- ============================================================================

ALTER TABLE "BusinessTransaction" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- ============================================================================
-- BusinessObligation — add vendor, status, updatedAt
-- ============================================================================

ALTER TABLE "BusinessObligation" ADD COLUMN "vendor" TEXT;
ALTER TABLE "BusinessObligation" ADD COLUMN "status" "ObligationStatus" NOT NULL DEFAULT 'PENDING';
ALTER TABLE "BusinessObligation" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
