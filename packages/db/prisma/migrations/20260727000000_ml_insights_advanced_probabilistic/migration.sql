-- Phase 14.1: ML Insights — advanced probabilistic models
-- Adds two additive, defaulted boolean columns to MlInsightRun so history rows can be
-- filtered/queried directly (e.g. "how often has concept drift fired this year")
-- without deserializing the full `summary` JSON blob — same convention as the
-- existing driftDetected/cashflowStressRisk columns. Both default to false so
-- existing rows remain valid with no backfill required.
ALTER TABLE "MlInsightRun" ADD COLUMN "conceptDriftDetected" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "MlInsightRun" ADD COLUMN "featureShiftDetected" BOOLEAN NOT NULL DEFAULT false;
