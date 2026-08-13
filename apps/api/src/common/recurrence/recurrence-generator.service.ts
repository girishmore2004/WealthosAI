import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Expense, Income, Prisma, Recurrence } from "@wealthos/db";
import { PrismaService } from "../../prisma/prisma.service";
import { computeMissedOccurrences } from "./recurrence.util";

type SourceType = "INCOME" | "EXPENSE";

export interface RecurrencePreviewEntry {
  occurrenceDate: string;
}

export interface RecurrenceGenerationSummary {
  sourceType: SourceType;
  sourceId: string;
  generated: number;
}

// Audit item #3: materializes real Income/Expense rows for every "missed" occurrence
// of an opted-in recurring template, up to today. Two entry points:
//   - generateForUser(userId): called synchronously (e.g. from a controller action or
//     a per-user on-demand refresh) — processes only that user's active templates.
//   - generateAll(): called by the scheduled BullMQ job — processes every user with at
//     least one active template.
// Both share the same per-template generation logic, so there is exactly one
// implementation of "how a template advances," not two independently-maintained copies.
@Injectable()
export class RecurrenceGeneratorService {
  private readonly logger = new Logger(RecurrenceGeneratorService.name);

  constructor(private prisma: PrismaService) {}

  // --- Activation (opt-in, per master preservation rules) --------------------------

  async activateIncomeRecurrence(userId: string, incomeId: string, endDate?: string) {
    const income = await this.prisma.client.income.findUnique({ where: { id: incomeId } });
    if (!income || income.userId !== userId) throw new NotFoundException("Income record not found");
    if (income.recurrence === "ONE_TIME") {
      throw new BadRequestException("A ONE_TIME income row has no recurrence cadence to activate.");
    }
    return this.prisma.client.income.update({
      where: { id: incomeId },
      data: {
        recurrenceActive: true,
        recurrenceEndDate: endDate ? new Date(endDate) : null,
        // Seed nextOccurrenceAt from the row's own date if this is the first
        // activation (nextOccurrenceAt is null) — otherwise leave whatever
        // generation has already advanced it to untouched, so re-activating after a
        // pause resumes from where it left off rather than jumping back to the
        // original date and regenerating already-generated occurrences (which the
        // RecurringEventLog unique constraint would reject anyway, but there's no
        // reason to attempt it).
        nextOccurrenceAt: income.nextOccurrenceAt ?? income.receivedAt,
      },
    });
  }

  async deactivateIncomeRecurrence(userId: string, incomeId: string) {
    const result = await this.prisma.client.income.updateMany({
      where: { id: incomeId, userId },
      data: { recurrenceActive: false },
    });
    if (result.count === 0) throw new NotFoundException("Income record not found");
    return this.prisma.client.income.findUnique({ where: { id: incomeId } });
  }

  async activateExpenseRecurrence(userId: string, expenseId: string, recurrence: Exclude<Recurrence, "ONE_TIME">, endDate?: string) {
    const expense = await this.prisma.client.expense.findUnique({ where: { id: expenseId } });
    if (!expense || expense.userId !== userId) throw new NotFoundException("Expense record not found");
    return this.prisma.client.expense.update({
      where: { id: expenseId },
      data: {
        recurrence,
        recurrenceActive: true,
        recurrenceEndDate: endDate ? new Date(endDate) : null,
        nextOccurrenceAt: expense.nextOccurrenceAt ?? expense.spentAt,
      },
    });
  }

  async deactivateExpenseRecurrence(userId: string, expenseId: string) {
    const result = await this.prisma.client.expense.updateMany({
      where: { id: expenseId, userId },
      data: { recurrenceActive: false },
    });
    if (result.count === 0) throw new NotFoundException("Expense record not found");
    return this.prisma.client.expense.findUnique({ where: { id: expenseId } });
  }

  // --- Preview / dry-run -------------------------------------------------------------
  // "Add a preview endpoint or dry-run mode" — computes what WOULD be generated
  // without writing anything, reusing the exact same pure computeMissedOccurrences()
  // the real generation path uses, so the preview can never drift from reality.

  async previewIncomeOccurrences(userId: string, incomeId: string): Promise<RecurrencePreviewEntry[]> {
    const income = await this.prisma.client.income.findUnique({ where: { id: incomeId } });
    if (!income || income.userId !== userId) throw new NotFoundException("Income record not found");
    if (income.recurrence === "ONE_TIME") return [];

    const startAfter = income.nextOccurrenceAt ?? income.receivedAt;
    const occurrences = computeMissedOccurrences(startAfter, income.recurrence, new Date(), {
      endDate: income.recurrenceEndDate,
    });
    return occurrences.map((d) => ({ occurrenceDate: d.toISOString() }));
  }

  async previewExpenseOccurrences(userId: string, expenseId: string): Promise<RecurrencePreviewEntry[]> {
    const expense = await this.prisma.client.expense.findUnique({ where: { id: expenseId } });
    if (!expense || expense.userId !== userId) throw new NotFoundException("Expense record not found");
    if (!expense.recurrence || expense.recurrence === "ONE_TIME") return [];

    const startAfter = expense.nextOccurrenceAt ?? expense.spentAt;
    const occurrences = computeMissedOccurrences(startAfter, expense.recurrence, new Date(), {
      endDate: expense.recurrenceEndDate,
    });
    return occurrences.map((d) => ({ occurrenceDate: d.toISOString() }));
  }

  // --- Actual generation --------------------------------------------------------------

  // Generates missed occurrences for every active recurring Income/Expense template
  // belonging to `userId`, up to today. Idempotent — safe to call repeatedly (e.g. a
  // user manually refreshing, or a retried job): each occurrence is protected by
  // RecurringEventLog's unique constraint, so calling this twice in a row for the same
  // user produces zero additional rows the second time.
  async generateForUser(userId: string): Promise<RecurrenceGenerationSummary[]> {
    const [incomeTemplates, expenseTemplates] = await Promise.all([
      this.prisma.client.income.findMany({ where: { userId, recurrenceActive: true } }),
      this.prisma.client.expense.findMany({ where: { userId, recurrenceActive: true } }),
    ]);

    const summaries: RecurrenceGenerationSummary[] = [];

    for (const template of incomeTemplates) {
      const generated = await this.generateIncomeOccurrences(userId, template);
      summaries.push({ sourceType: "INCOME", sourceId: template.id, generated });
    }
    for (const template of expenseTemplates) {
      const generated = await this.generateExpenseOccurrences(userId, template);
      summaries.push({ sourceType: "EXPENSE", sourceId: template.id, generated });
    }

    const totalGenerated = summaries.reduce((sum, s) => sum + s.generated, 0);
    if (totalGenerated > 0) {
      // "Add an audit record for generated records" — one summary row per
      // generateForUser() call rather than one per individual generated transaction,
      // which would make AuditLog noisy for an account with many active templates
      // without adding meaningfully more information (each generated row is already
      // individually traceable via RecurringEventLog and generatedFromRecurringId).
      await this.prisma.client.auditLog.create({
        data: {
          userId,
          action: "RECURRING_TRANSACTIONS_GENERATED",
          metadata: { summaries } as unknown as Prisma.InputJsonValue,
        },
      });
    }

    return summaries;
  }

  // Used by the scheduled BullMQ job (RecurrenceWorker) — processes every user with at
  // least one active recurring template, not just one user at a time.
  async generateAll(): Promise<{ usersProcessed: number; totalGenerated: number }> {
    const [incomeUserIds, expenseUserIds] = await Promise.all([
      this.prisma.client.income.findMany({ where: { recurrenceActive: true }, select: { userId: true }, distinct: ["userId"] }),
      this.prisma.client.expense.findMany({ where: { recurrenceActive: true }, select: { userId: true }, distinct: ["userId"] }),
    ]);
    const userIds = Array.from(new Set([...incomeUserIds.map((u) => u.userId), ...expenseUserIds.map((u) => u.userId)]));

    let totalGenerated = 0;
    for (const userId of userIds) {
      try {
        const summaries = await this.generateForUser(userId);
        totalGenerated += summaries.reduce((sum, s) => sum + s.generated, 0);
      } catch (err) {
        // One user's bad data (e.g. a corrupted recurrenceEndDate) must never abort
        // generation for every other user in the same run — "jobs fail safely," per
        // the master backend rules.
        this.logger.error(`Recurring-transaction generation failed for user ${userId}: ${(err as Error).message}`);
      }
    }

    return { usersProcessed: userIds.length, totalGenerated };
  }

  private async generateIncomeOccurrences(userId: string, template: Income): Promise<number> {
    if (template.recurrence === "ONE_TIME") return 0;

    const startAfter = template.nextOccurrenceAt ?? template.receivedAt;
    const occurrences = computeMissedOccurrences(startAfter, template.recurrence, new Date(), {
      endDate: template.recurrenceEndDate,
    });

    let generated = 0;
    let latestOccurrence = startAfter;

    for (const occurrenceDate of occurrences) {
      const created = await this.tryGenerateIncomeRow(userId, template, occurrenceDate);
      if (created) generated++;
      latestOccurrence = occurrenceDate; // advance regardless of created/skipped, so a
      // partially-generated backlog (e.g. this exact occurrence already logged by a
      // concurrent run) still moves nextOccurrenceAt forward instead of retrying it
      // forever on every subsequent call.
    }

    if (occurrences.length > 0) {
      await this.prisma.client.income.update({
        where: { id: template.id },
        data: { nextOccurrenceAt: latestOccurrence },
      });
    }

    return generated;
  }

  private async tryGenerateIncomeRow(userId: string, template: Income, occurrenceDate: Date): Promise<boolean> {
    try {
      const generatedRecord = await this.prisma.client.income.create({
        data: {
          userId,
          source: template.source,
          label: template.label,
          amount: template.amount,
          currency: template.currency,
          recurrence: template.recurrence,
          receivedAt: occurrenceDate,
          notes: template.notes,
          generatedFromRecurringId: template.id,
          // A generated row is not itself an active recurrence template — it's one
          // materialized occurrence of the template above. Only the original template
          // row (template.id) drives further generation.
          recurrenceActive: false,
        },
      });

      await this.prisma.client.recurringEventLog.create({
        data: {
          userId,
          sourceType: "INCOME",
          sourceId: template.id,
          occurrenceDate,
          generatedRecordId: generatedRecord.id,
        },
      });

      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Idempotency in action: this exact occurrence was already generated (by a
        // prior run or a concurrent one) — not an error, just nothing new to do.
        return false;
      }
      throw err;
    }
  }

  private async generateExpenseOccurrences(userId: string, template: Expense): Promise<number> {
    if (!template.recurrence || template.recurrence === "ONE_TIME") return 0;

    const startAfter = template.nextOccurrenceAt ?? template.spentAt;
    const occurrences = computeMissedOccurrences(startAfter, template.recurrence, new Date(), {
      endDate: template.recurrenceEndDate,
    });

    let generated = 0;
    let latestOccurrence = startAfter;

    for (const occurrenceDate of occurrences) {
      const created = await this.tryGenerateExpenseRow(userId, template, occurrenceDate);
      if (created) generated++;
      latestOccurrence = occurrenceDate;
    }

    if (occurrences.length > 0) {
      await this.prisma.client.expense.update({
        where: { id: template.id },
        data: { nextOccurrenceAt: latestOccurrence },
      });
    }

    return generated;
  }

  private async tryGenerateExpenseRow(userId: string, template: Expense, occurrenceDate: Date): Promise<boolean> {
    try {
      const generatedRecord = await this.prisma.client.expense.create({
        data: {
          userId,
          categoryId: template.categoryId,
          merchant: template.merchant,
          amount: template.amount,
          currency: template.currency,
          spentAt: occurrenceDate,
          paymentMethod: template.paymentMethod,
          notes: template.notes,
          isRecurring: true,
          generatedFromRecurringId: template.id,
          recurrenceActive: false,
        },
      });

      await this.prisma.client.recurringEventLog.create({
        data: {
          userId,
          sourceType: "EXPENSE",
          sourceId: template.id,
          occurrenceDate,
          generatedRecordId: generatedRecord.id,
        },
      });

      return true;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        return false;
      }
      throw err;
    }
  }
}
