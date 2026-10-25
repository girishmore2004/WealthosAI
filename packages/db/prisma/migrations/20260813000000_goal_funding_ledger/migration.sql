-- WealthOS AI — Money → Goals: one funding ledger for every goal.
--
-- 1. SCHEMA (purely additive — no column, table or row is dropped or rewritten):
--      Goal.archivedAt / Goal.deadlineSet
--      GoalEntry                    the per-goal funding ledger (same entry types as the emergency reserve)
--      EmergencyFundEntry           + idempotencyKey, + transferGroupId (repeat-submission guard, paired moves)
-- 2. DATA (so existing users lose nothing and the new page is complete on day one):
--      a. a user who already has emergency-reserve data but no EMERGENCY_FUND goal gets one (the reserve
--         ledger is mapped to their OLDEST EMERGENCY_FUND goal; no money is copied or duplicated);
--      b. the emergency plan's target / date / monthly contribution is mirrored onto that goal;
--      c. a goal's hand-typed "current amount" becomes an OPENING_BALANCE ledger entry, so the ledger
--         explains the number instead of the number floating free of any history:
--           - every goal except the primary emergency goal -> GoalEntry ALLOCATE (earmark inside the
--             user's own cash: no cash, income, expense or net-worth effect);
--           - the primary emergency goal, only when it has NO reserve entries yet -> EmergencyFundEntry
--             ALLOCATE (the reserve model already treats that money as moved out of available cash);
--      d. the primary emergency goal's currentAmount is set to the reserve ledger balance.
-- Hand-derived like the previous migrations; verified by applying the whole migration chain to a real
-- PostgreSQL 16 database and reconciling balances (see the delivery notes).

-- 1. SCHEMA ------------------------------------------------------------------------------------

ALTER TABLE "Goal"
    ADD COLUMN "archivedAt" TIMESTAMP(3),
    ADD COLUMN "deadlineSet" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "Goal_userId_archivedAt_idx" ON "Goal"("userId", "archivedAt");

ALTER TABLE "EmergencyFundEntry"
    ADD COLUMN "idempotencyKey" TEXT,
    ADD COLUMN "transferGroupId" TEXT;

CREATE UNIQUE INDEX "EmergencyFundEntry_userId_idempotencyKey_key" ON "EmergencyFundEntry"("userId", "idempotencyKey");
CREATE INDEX "EmergencyFundEntry_userId_transferGroupId_idx" ON "EmergencyFundEntry"("userId", "transferGroupId");

CREATE TABLE "GoalEntry" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "goalId" TEXT NOT NULL,
    "type" "EmergencyFundEntryType" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "reason" TEXT,
    "notes" TEXT,
    "idempotencyKey" TEXT,
    "transferGroupId" TEXT,
    "expenseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoalEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GoalEntry_userId_idempotencyKey_key" ON "GoalEntry"("userId", "idempotencyKey");
CREATE INDEX "GoalEntry_goalId_occurredAt_idx" ON "GoalEntry"("goalId", "occurredAt");
CREATE INDEX "GoalEntry_userId_transferGroupId_idx" ON "GoalEntry"("userId", "transferGroupId");

ALTER TABLE "GoalEntry" ADD CONSTRAINT "GoalEntry_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GoalEntry" ADD CONSTRAINT "GoalEntry_goalId_fkey"
    FOREIGN KEY ("goalId") REFERENCES "Goal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. DATA --------------------------------------------------------------------------------------

-- a. An emergency goal for every user who already has emergency-reserve data but no such goal.
INSERT INTO "Goal" ("id", "userId", "type", "name", "targetAmount", "targetDate", "currentAmount",
                    "monthlyContribution", "deadlineSet", "createdAt", "updatedAt")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || u."userId"), 1, 24),
       u."userId",
       'EMERGENCY_FUND',
       'Emergency fund',
       COALESCE(p."targetAmount", 0),
       COALESCE(p."targetDate", CURRENT_TIMESTAMP + INTERVAL '1 year'),
       0,
       COALESCE(p."monthlyContribution", 0),
       (p."targetDate" IS NOT NULL),
       CURRENT_TIMESTAMP,
       CURRENT_TIMESTAMP
FROM (
    SELECT "userId" FROM "EmergencyFundEntry"
    UNION
    SELECT "userId" FROM "EmergencyFundPlan"
     WHERE "targetAmount" IS NOT NULL OR "targetMonths" IS NOT NULL
        OR "monthlyContribution" IS NOT NULL OR "targetDate" IS NOT NULL
) u
LEFT JOIN "EmergencyFundPlan" p ON p."userId" = u."userId"
WHERE NOT EXISTS (
    SELECT 1 FROM "Goal" g WHERE g."userId" = u."userId" AND g."type" = 'EMERGENCY_FUND'
);

-- b. Mirror the plan onto the primary (oldest) emergency goal. The plan stays authoritative for the
--    target (it also supports "N months of expenses"); the goal row just carries the same values for
--    every reader that does not go through GoalFundingService.
UPDATE "Goal" g
SET "targetAmount"        = COALESCE(p."targetAmount", g."targetAmount"),
    "targetDate"          = COALESCE(p."targetDate", g."targetDate"),
    "deadlineSet"         = CASE WHEN p."targetDate" IS NOT NULL THEN true ELSE g."deadlineSet" END,
    "monthlyContribution" = COALESCE(p."monthlyContribution", g."monthlyContribution"),
    "updatedAt"           = CURRENT_TIMESTAMP
FROM "EmergencyFundPlan" p
WHERE p."userId" = g."userId"
  AND g."type" = 'EMERGENCY_FUND'
  AND g."id" = (
      SELECT g2."id" FROM "Goal" g2
      WHERE g2."userId" = g."userId" AND g2."type" = 'EMERGENCY_FUND'
      ORDER BY g2."createdAt", g2."id" LIMIT 1
  );

-- c1. Primary emergency goal that has a typed amount but no reserve entries yet -> reserve opening entry.
INSERT INTO "EmergencyFundEntry" ("id", "userId", "type", "amount", "occurredAt", "origin", "reason", "createdAt")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || g."id"), 1, 24),
       g."userId", 'ALLOCATE', g."currentAmount", g."createdAt", 'OPENING_BALANCE', 'Opening balance', CURRENT_TIMESTAMP
FROM "Goal" g
WHERE g."type" = 'EMERGENCY_FUND'
  AND g."currentAmount" > 0
  AND g."id" = (
      SELECT g2."id" FROM "Goal" g2
      WHERE g2."userId" = g."userId" AND g2."type" = 'EMERGENCY_FUND'
      ORDER BY g2."createdAt", g2."id" LIMIT 1
  )
  AND NOT EXISTS (SELECT 1 FROM "EmergencyFundEntry" e WHERE e."userId" = g."userId");

-- c2. Every other goal's typed amount -> an opening ledger entry (an earmark: no cash effect).
INSERT INTO "GoalEntry" ("id", "userId", "goalId", "type", "amount", "occurredAt", "origin", "reason", "createdAt")
SELECT 'c' || substr(md5(random()::text || clock_timestamp()::text || g."id"), 1, 24),
       g."userId", g."id", 'ALLOCATE', g."currentAmount", g."createdAt", 'OPENING_BALANCE', 'Opening balance', CURRENT_TIMESTAMP
FROM "Goal" g
WHERE g."currentAmount" > 0
  AND NOT (
      g."type" = 'EMERGENCY_FUND'
      AND g."id" = (
          SELECT g2."id" FROM "Goal" g2
          WHERE g2."userId" = g."userId" AND g2."type" = 'EMERGENCY_FUND'
          ORDER BY g2."createdAt", g2."id" LIMIT 1
      )
  );

-- d. The primary emergency goal's currentAmount = the reserve ledger balance (the canonical signed effect).
UPDATE "Goal" g
SET "currentAmount" = r."balance",
    "updatedAt"     = CURRENT_TIMESTAMP
FROM (
    SELECT e."userId",
           SUM(CASE e."type"
                 WHEN 'ALLOCATE'     THEN abs(e."amount")
                 WHEN 'TRANSFER_IN'  THEN abs(e."amount")
                 WHEN 'RELEASE'      THEN -abs(e."amount")
                 WHEN 'WITHDRAWAL'   THEN -abs(e."amount")
                 WHEN 'TRANSFER_OUT' THEN -abs(e."amount")
                 ELSE e."amount"
               END) AS "balance"
    FROM "EmergencyFundEntry" e
    GROUP BY e."userId"
) r
WHERE r."userId" = g."userId"
  AND g."type" = 'EMERGENCY_FUND'
  AND g."id" = (
      SELECT g2."id" FROM "Goal" g2
      WHERE g2."userId" = g."userId" AND g2."type" = 'EMERGENCY_FUND'
      ORDER BY g2."createdAt", g2."id" LIMIT 1
  );
