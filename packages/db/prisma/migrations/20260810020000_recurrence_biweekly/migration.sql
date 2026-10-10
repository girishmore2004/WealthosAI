-- WealthOS AI — money-flow phase 1, batch 5: BIWEEKLY recurrence cadence (every 14 days).
--
-- Kept in its OWN migration on purpose: on PostgreSQL a newly added enum value cannot be used
-- in the same transaction that adds it, so nothing else may share this file. Existing rows and
-- every existing cadence are untouched.

ALTER TYPE "Recurrence" ADD VALUE IF NOT EXISTS 'BIWEEKLY' AFTER 'WEEKLY';
