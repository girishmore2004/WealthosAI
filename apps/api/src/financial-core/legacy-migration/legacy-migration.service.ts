import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { AuditService } from "../../audit/audit.service";
import { isUniqueViolation } from "../../common/utils/prisma-errors.util";
import {
  MigrationSummary,
  PlannedItem,
  planLegacyMigration,
  summarize,
} from "./legacy-migration.planner";

export interface LegacyMigrationReport {
  dryRun: boolean;
  summary: MigrationSummary;
  items: PlannedItem[];
}

const AUDIT_ITEM_CAP = 500;

// Migrates the CALLING USER's legacy SAVINGS-category expenses into InvestmentCashflow /
// EmergencyFundEntry. Safe to run repeatedly:
//   * Idempotent — each created row records `sourceExpenseId` (UNIQUE), so a re-run, a
//     retry, or a concurrent run can never create a second row for the same expense.
//   * Non-destructive — the original Expense is never edited or deleted.
//   * Auditable — a summary and per-expense outcome are written to the audit log.
//   * Conservative — ambiguous rows are reported as WARNING and left untouched.
// Always call with dryRun = true first to preview.
@Injectable()
export class LegacyMigrationService {
  private readonly logger = new Logger(LegacyMigrationService.name);

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async run(userId: string, dryRun = true): Promise<LegacyMigrationReport> {
    const db = this.prisma.client;

    const [expenses, investments, cashflowRefs, entryRefs, contributions] = await Promise.all([
      db.expense.findMany({
        where: { userId, category: { type: "SAVINGS" } },
        select: {
          id: true,
          amount: true,
          spentAt: true,
          merchant: true,
          notes: true,
          category: { select: { name: true } },
        },
        orderBy: { spentAt: "asc" },
      }),
      db.investment.findMany({ where: { userId }, select: { id: true, name: true } }),
      db.investmentCashflow.findMany({ where: { userId, sourceExpenseId: { not: null } }, select: { sourceExpenseId: true } }),
      db.emergencyFundEntry.findMany({ where: { userId, sourceExpenseId: { not: null } }, select: { sourceExpenseId: true } }),
      db.investmentCashflow.findMany({
        where: { userId, type: "CONTRIBUTION" },
        select: { investmentId: true, occurredAt: true, amount: true },
      }),
    ]);

    const migrated = new Set<string>();
    for (const r of cashflowRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);
    for (const r of entryRefs) if (r.sourceExpenseId) migrated.add(r.sourceExpenseId);

    const plan = planLegacyMigration({
      expenses: expenses.map((e) => ({
        id: e.id,
        amount: e.amount.toString(),
        spentAt: e.spentAt,
        merchant: e.merchant,
        notes: e.notes,
        categoryName: e.category.name,
      })),
      investments,
      alreadyMigratedExpenseIds: migrated,
      existingContributions: contributions.map((c) => ({
        investmentId: c.investmentId,
        occurredAt: c.occurredAt,
        amount: c.amount.toString(),
      })),
    });

    const byId = new Map(expenses.map((e) => [e.id, e]));
    const items: PlannedItem[] = [];

    for (const item of plan) {
      if (dryRun || item.status !== "MIGRATED") {
        items.push(item);
        continue;
      }
      const source = byId.get(item.expenseId);
      if (!source) {
        items.push({ ...item, status: "ERROR", reason: "Source expense disappeared during migration." });
        continue;
      }
      try {
        if (item.target === "EMERGENCY_ALLOCATION") {
          await db.emergencyFundEntry.create({
            data: {
              userId,
              type: "ALLOCATE",
              amount: source.amount,
              occurredAt: source.spentAt,
              origin: "LEGACY_EXPENSE_MIGRATION",
              sourceExpenseId: source.id,
              notes: source.notes ?? undefined,
            },
          });
        } else if (item.target === "INVESTMENT_CONTRIBUTION" && item.investmentId) {
          await db.investmentCashflow.create({
            data: {
              userId,
              investmentId: item.investmentId,
              type: "CONTRIBUTION",
              amount: source.amount,
              occurredAt: source.spentAt,
              periodKey: item.periodKey,
              origin: "LEGACY_EXPENSE_MIGRATION",
              sourceExpenseId: source.id,
              notes: source.notes ?? undefined,
            },
          });
        }
        items.push(item);
      } catch (err) {
        if (isUniqueViolation(err)) {
          // Lost a race with another run (or a manual entry took the slot): treat as
          // already handled, never as a failure and never as a second row.
          items.push({ ...item, status: "DUPLICATE", reason: "Already created by a concurrent run or entry." });
        } else {
          // Surfaced, never swallowed — and the type of error only, no financial payload.
          this.logger.error(`Legacy migration failed for expense ${item.expenseId}: ${(err as Error).name}`);
          items.push({ ...item, status: "ERROR", reason: "Database error while migrating this expense." });
        }
      }
    }

    const summary = summarize(items);

if (!dryRun) {
  const auditMetadata = {
    summary: {
      MIGRATED: summary.MIGRATED,
      SKIPPED: summary.SKIPPED,
      DUPLICATE: summary.DUPLICATE,
      WARNING: summary.WARNING,
      ERROR: summary.ERROR,
    },
    items: items
      .slice(0, AUDIT_ITEM_CAP)
      .map((i) => ({
        expenseId: i.expenseId,
        status: i.status,
        target: i.target,
        periodKey: i.periodKey ?? null,
      })),
    truncated: items.length > AUDIT_ITEM_CAP,
  };

  await this.audit.log(
    "FINANCIAL_LEGACY_MIGRATION",
    userId,
    auditMetadata,
  );
}
    }
    return { dryRun, summary, items };
  }
}
