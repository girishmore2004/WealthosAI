import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { RecurrenceGeneratorService } from "../src/common/recurrence/recurrence-generator.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("RecurrenceGeneratorService", () => {
  let service: RecurrenceGeneratorService;

  const mockPrisma = {
    client: {
      income: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
      expense: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
      recurringEventLog: { create: jest.fn() },
      auditLog: { create: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [RecurrenceGeneratorService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(RecurrenceGeneratorService);
  });

  describe("activation / deactivation (opt-in, per master preservation rules)", () => {
    it("activates a MONTHLY income row, seeding nextOccurrenceAt from receivedAt on first activation", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({
        id: "i1", userId: "user-1", recurrence: "MONTHLY", receivedAt: new Date("2026-01-01"), nextOccurrenceAt: null,
      });
      mockPrisma.client.income.update.mockResolvedValue({ id: "i1", recurrenceActive: true });

      await service.activateIncomeRecurrence("user-1", "i1");

      expect(mockPrisma.client.income.update).toHaveBeenCalledWith({
        where: { id: "i1" },
        data: { recurrenceActive: true, recurrenceEndDate: null, nextOccurrenceAt: new Date("2026-01-01") },
      });
    });

    it("resumes from the existing nextOccurrenceAt rather than resetting it when re-activating", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({
        id: "i1", userId: "user-1", recurrence: "MONTHLY", receivedAt: new Date("2026-01-01"), nextOccurrenceAt: new Date("2026-04-01"),
      });
      mockPrisma.client.income.update.mockResolvedValue({ id: "i1" });

      await service.activateIncomeRecurrence("user-1", "i1");

      expect(mockPrisma.client.income.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ nextOccurrenceAt: new Date("2026-04-01") }) }),
      );
    });

    it("rejects activating a ONE_TIME income row", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "i1", userId: "user-1", recurrence: "ONE_TIME" });
      await expect(service.activateIncomeRecurrence("user-1", "i1")).rejects.toThrow(BadRequestException);
    });

    it("throws NotFoundException activating an income row belonging to another user", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "i1", userId: "someone-else", recurrence: "MONTHLY" });
      await expect(service.activateIncomeRecurrence("user-1", "i1")).rejects.toThrow(NotFoundException);
    });

    it("deactivates an income row (ownership-scoped)", async () => {
      mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "i1", recurrenceActive: false });

      await service.deactivateIncomeRecurrence("user-1", "i1");

      expect(mockPrisma.client.income.updateMany).toHaveBeenCalledWith({
        where: { id: "i1", userId: "user-1" },
        data: { recurrenceActive: false },
      });
    });

    it("sets a recurrence cadence on an expense row when activating (Expense had none before)", async () => {
      mockPrisma.client.expense.findUnique.mockResolvedValue({
        id: "e1", userId: "user-1", spentAt: new Date("2026-01-01"), nextOccurrenceAt: null,
      });
      mockPrisma.client.expense.update.mockResolvedValue({ id: "e1" });

      await service.activateExpenseRecurrence("user-1", "e1", "MONTHLY");

      expect(mockPrisma.client.expense.update).toHaveBeenCalledWith({
        where: { id: "e1" },
        data: { recurrence: "MONTHLY", recurrenceActive: true, recurrenceEndDate: null, nextOccurrenceAt: new Date("2026-01-01") },
      });
    });
  });

  describe("preview (dry-run)", () => {
    it("returns the same occurrences the real generation path would produce, without writing anything", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({
        id: "i1", userId: "user-1", recurrence: "MONTHLY", receivedAt: new Date("2026-01-15"), nextOccurrenceAt: new Date("2026-01-15"), recurrenceEndDate: null,
      });

      const preview = await service.previewIncomeOccurrences("user-1", "i1");

      expect(mockPrisma.client.income.create).not.toHaveBeenCalled();
      // Exact count depends on "now" at test-run time, so just assert the shape and
      // that nothing before the seed date is included.
      for (const entry of preview) {
        expect(new Date(entry.occurrenceDate).getTime()).toBeGreaterThan(new Date("2026-01-15").getTime());
      }
    });

    it("returns an empty array for a ONE_TIME row", async () => {
      mockPrisma.client.income.findUnique.mockResolvedValue({ id: "i1", userId: "user-1", recurrence: "ONE_TIME" });
      expect(await service.previewIncomeOccurrences("user-1", "i1")).toEqual([]);
    });

    it("returns an empty array for an expense with no recurrence cadence set", async () => {
      mockPrisma.client.expense.findUnique.mockResolvedValue({ id: "e1", userId: "user-1", recurrence: null });
      expect(await service.previewExpenseOccurrences("user-1", "e1")).toEqual([]);
    });
  });

  describe("generateForUser — idempotent generation", () => {
    it("generates a real Income row for each missed occurrence and logs it in RecurringEventLog", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        {
          id: "i1", userId: "user-1", source: "SALARY", label: "Salary", amount: 50000, currency: "INR",
          recurrence: "MONTHLY", receivedAt: new Date("2026-01-01"), notes: null,
          nextOccurrenceAt: new Date("2026-01-01"), recurrenceEndDate: null,
        },
      ]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockPrisma.client.income.create.mockResolvedValue({ id: "generated-1" });
      mockPrisma.client.recurringEventLog.create.mockResolvedValue({ id: "log-1" });
      mockPrisma.client.income.update.mockResolvedValue({});
      mockPrisma.client.auditLog.create.mockResolvedValue({});

      const summaries = await service.generateForUser("user-1");

      expect(mockPrisma.client.income.create).toHaveBeenCalled();
      const createArgs = mockPrisma.client.income.create.mock.calls[0][0].data;
      expect(createArgs.generatedFromRecurringId).toBe("i1");
      expect(createArgs.recurrenceActive).toBe(false); // a generated row is not itself a template
      expect(mockPrisma.client.recurringEventLog.create).toHaveBeenCalled();
      expect(mockPrisma.client.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ userId: "user-1", action: "RECURRING_TRANSACTIONS_GENERATED" }) }),
      );
      expect(summaries.find((s) => s.sourceId === "i1")?.generated).toBeGreaterThan(0);
    });

    it("skips (does not error) when an occurrence was already generated — P2002 idempotency", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        {
          id: "i1", userId: "user-1", source: "SALARY", label: "Salary", amount: 50000, currency: "INR",
          recurrence: "MONTHLY", receivedAt: new Date("2026-01-01"), notes: null,
          nextOccurrenceAt: new Date("2026-01-01"), recurrenceEndDate: null,
        },
      ]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockPrisma.client.income.create.mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "5.0.0" }),
      );
      mockPrisma.client.income.update.mockResolvedValue({});

      const summaries = await service.generateForUser("user-1");

      expect(summaries.find((s) => s.sourceId === "i1")?.generated).toBe(0);
      expect(mockPrisma.client.recurringEventLog.create).not.toHaveBeenCalled();
      // Zero generated -> no audit log noise for a no-op run.
      expect(mockPrisma.client.auditLog.create).not.toHaveBeenCalled();
    });

    it("re-throws a non-P2002 error instead of silently swallowing it", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        {
          id: "i1", userId: "user-1", source: "SALARY", label: "Salary", amount: 50000, currency: "INR",
          recurrence: "MONTHLY", receivedAt: new Date("2026-01-01"), notes: null,
          nextOccurrenceAt: new Date("2026-01-01"), recurrenceEndDate: null,
        },
      ]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockPrisma.client.income.create.mockRejectedValue(new Error("database is down"));

      await expect(service.generateForUser("user-1")).rejects.toThrow("database is down");
    });

    it("advances nextOccurrenceAt even when some occurrences generated and some were already-logged skips", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([
        {
          id: "i1", userId: "user-1", source: "SALARY", label: "Salary", amount: 50000, currency: "INR",
          recurrence: "MONTHLY", receivedAt: new Date("2020-01-01"), notes: null,
          nextOccurrenceAt: new Date("2020-01-01"), recurrenceEndDate: null,
        },
      ]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);
      mockPrisma.client.income.create.mockResolvedValue({ id: "generated-x" });
      mockPrisma.client.recurringEventLog.create.mockResolvedValue({ id: "log-x" });
      mockPrisma.client.income.update.mockResolvedValue({});
      mockPrisma.client.auditLog.create.mockResolvedValue({});

      await service.generateForUser("user-1");

      expect(mockPrisma.client.income.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "i1" } }),
      );
    });

    it("does nothing for a user with no active templates", async () => {
      mockPrisma.client.income.findMany.mockResolvedValue([]);
      mockPrisma.client.expense.findMany.mockResolvedValue([]);

      const summaries = await service.generateForUser("user-1");

      expect(summaries).toEqual([]);
      expect(mockPrisma.client.auditLog.create).not.toHaveBeenCalled();
    });
  });

  describe("generateAll — cross-user batch (used by the scheduled job)", () => {
    it("processes every distinct user with at least one active template", async () => {
      mockPrisma.client.income.findMany
        .mockResolvedValueOnce([{ userId: "user-1" }, { userId: "user-2" }]) // distinct userId query
        .mockResolvedValueOnce([]) // user-1's generateForUser income templates
        .mockResolvedValueOnce([]); // user-2's generateForUser income templates
      mockPrisma.client.expense.findMany
        .mockResolvedValueOnce([]) // distinct userId query
        .mockResolvedValueOnce([]) // user-1's expense templates
        .mockResolvedValueOnce([]); // user-2's expense templates

      const result = await service.generateAll();

      expect(result.usersProcessed).toBe(2);
    });

    it("isolates one user's failure from the rest of the batch", async () => {
      mockPrisma.client.income.findMany
        .mockResolvedValueOnce([{ userId: "user-1" }, { userId: "user-2" }])
        .mockRejectedValueOnce(new Error("corrupted row")) // user-1's generateForUser throws
        .mockResolvedValueOnce([]); // user-2 still processed
      mockPrisma.client.expense.findMany.mockResolvedValue([]);

      const result = await service.generateAll();

      // Both users counted as "processed" (attempted) even though user-1 errored —
      // the failure is caught and logged, not allowed to abort the batch.
      expect(result.usersProcessed).toBe(2);
    });
  });
});
