import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { LoansService } from "../src/loans/loans.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("LoansService", () => {
  let service: LoansService;
  const mockPrisma = {
    client: {
      loan: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
      },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        LoansService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
      ],
    }).compile();
    service = moduleRef.get(LoansService);
  });

  describe("amortizationSchedule (reducing-balance math)", () => {
    it("produces a schedule where the balance reaches zero and interest decreases each month", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 12, emiAmount: 15000,
      });

      const schedule = await service.amortizationSchedule("user-1", "l1");

      expect(schedule.length).toBeGreaterThan(0);
      expect(schedule[schedule.length - 1].balance).toBe(0);
      // interest portion should strictly decrease as the balance pays down
      for (let i = 1; i < schedule.length; i++) {
        expect(schedule[i].interest).toBeLessThanOrEqual(schedule[i - 1].interest);
      }
      // each row's emi = interest + principal
      for (const row of schedule) {
        expect(Number((row.interest + row.principal).toFixed(2))).toBeCloseTo(row.emi, 1);
      }
    });

    it("rejects access to a loan the user does not own", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({ id: "l1", userId: "someone-else" });
      await expect(service.amortizationSchedule("user-1", "l1")).rejects.toThrow();
    });

    it("rejects access to a loan that doesn't exist, with the same error as a cross-user access attempt", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue(null);
      await expect(service.amortizationSchedule("user-1", "does-not-exist")).rejects.toThrow(NotFoundException);
    });

    it("stops safely (does not infinite-loop) when the EMI doesn't cover interest", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 1000000, interestRateAnnual: 24, emiAmount: 100, // EMI far too low
      });

      const schedule = await service.amortizationSchedule("user-1", "l1");

      expect(schedule.length).toBeLessThan(600); // safety cap never silently hangs
      expect(schedule[schedule.length - 1].balance).toBeGreaterThan(0); // never actually paid off
    });
  });

  describe("simulateAmortization (floating-rate support, new)", () => {
    it("matches the plain (no rate change) schedule when no rate changes are given", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 12, emiAmount: 15000,
      });

      const plain = await service.amortizationSchedule("user-1", "l1");
      const simulated = await service.simulateAmortization("user-1", "l1", {});

      expect(simulated).toEqual(plain);
    });

    it("applies a rate increase starting from the specified month, raising the interest portion from that point on", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 8, emiAmount: 15000,
      });

      const schedule = await service.simulateAmortization("user-1", "l1", {
        rateChanges: [{ effectiveFromMonth: 6, newAnnualRatePercent: 12 }],
      });

      // Interest at month 5 (still 8%) should be noticeably lower than interest at
      // month 6 (now 12%), even though the balance only dropped slightly between them —
      // proving the rate change actually took effect at the specified month.
      const month5 = schedule.find((r) => r.month === 5)!;
      const month6 = schedule.find((r) => r.month === 6)!;
      expect(month6.interest).toBeGreaterThan(month5.interest);
    });

    it("applies multiple rate changes in chronological order regardless of input array order", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 8, emiAmount: 15000,
      });

      // Deliberately out of order in the input.
      const schedule = await service.simulateAmortization("user-1", "l1", {
        rateChanges: [
          { effectiveFromMonth: 12, newAnnualRatePercent: 6 }, // rate drops later
          { effectiveFromMonth: 6, newAnnualRatePercent: 12 }, // rate rises first
        ],
      });

      const month5 = schedule.find((r) => r.month === 5)!; // still 8%
      const month6 = schedule.find((r) => r.month === 6)!; // now 12%
      const month12 = schedule.find((r) => r.month === 12)!; // now 6%

      expect(month6.interest).toBeGreaterThan(month5.interest);
      expect(month12.interest).toBeLessThan(month6.interest);
    });

    it("lets the later entry win when two rate changes target the same month", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 8, emiAmount: 15000,
      });

      const scheduleA = await service.simulateAmortization("user-1", "l1", {
        rateChanges: [
          { effectiveFromMonth: 3, newAnnualRatePercent: 10 },
          { effectiveFromMonth: 3, newAnnualRatePercent: 14 }, // this one should win
        ],
      });
      const scheduleB = await service.simulateAmortization("user-1", "l1", {
        rateChanges: [{ effectiveFromMonth: 3, newAnnualRatePercent: 14 }],
      });

      expect(scheduleA.find((r) => r.month === 3)!.interest).toBeCloseTo(
        scheduleB.find((r) => r.month === 3)!.interest,
        2,
      );
    });

    it("combines a lump-sum prepayment with future rate changes in a single simulation", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 10, emiAmount: 12000,
      });

      const withPrepayment = await service.simulateAmortization("user-1", "l1", {
        lumpSumPrepayment: 100000,
        rateChanges: [{ effectiveFromMonth: 12, newAnnualRatePercent: 13 }],
      });

      expect(withPrepayment[0].balance).toBeLessThan(500000 - 100000 + 1); // prepayment applied up front
      expect(withPrepayment.length).toBeGreaterThan(0);
    });
  });

  describe("prepaymentImpact", () => {
    it("a lump-sum prepayment shortens tenure and reduces total interest versus the baseline", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 10, emiAmount: 12000,
      });

      const impact = await service.prepaymentImpact("user-1", "l1", 100000);

      expect(impact.monthsSaved).toBeGreaterThan(0);
      expect(impact.interestSaved).toBeGreaterThan(0);
      expect(impact.newTenureMonths).toBeLessThan(impact.originalTenureMonths);
    });

    it("is unaffected when called with only 3 arguments — the new rateChanges parameter defaults to a no-op (backward compatibility for SimulatorService's LOAN_PREPAYMENT scenario)", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 10, emiAmount: 12000,
      });

      const withoutRateChanges = await service.prepaymentImpact("user-1", "l1", 100000);
      const withEmptyRateChanges = await service.prepaymentImpact("user-1", "l1", 100000, []);

      expect(withoutRateChanges).toEqual(withEmptyRateChanges);
    });

    it("accounts for a future rate change identically in both the baseline and with-prepayment schedules, isolating the prepayment's effect", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({
        id: "l1", userId: "user-1",
        outstandingPrincipal: 500000, interestRateAnnual: 10, emiAmount: 12000,
      });

      const impact = await service.prepaymentImpact("user-1", "l1", 100000, [
        { effectiveFromMonth: 6, newAnnualRatePercent: 13 },
      ]);

      // A prepayment should still help even with a future rate rise applied equally to
      // both scenarios.
      expect(impact.monthsSaved).toBeGreaterThan(0);
      expect(impact.interestSaved).toBeGreaterThan(0);
    });
  });

  describe("payoffOrder", () => {
    it("snowball orders by smallest outstanding balance first", async () => {
      mockPrisma.client.loan.findMany.mockResolvedValue([
        { id: "big", outstandingPrincipal: 900000, interestRateAnnual: 8 },
        { id: "small", outstandingPrincipal: 50000, interestRateAnnual: 15 },
      ]);

      const order = await service.payoffOrder("user-1", "snowball");

      expect(order[0].loan.id).toBe("small");
      expect(order[0].priority).toBe(1);
    });

    it("avalanche orders by highest interest rate first", async () => {
      mockPrisma.client.loan.findMany.mockResolvedValue([
        { id: "big", outstandingPrincipal: 900000, interestRateAnnual: 8 },
        { id: "small", outstandingPrincipal: 50000, interestRateAnnual: 15 },
      ]);

      const order = await service.payoffOrder("user-1", "avalanche");

      expect(order[0].loan.id).toBe("small"); // 15% > 8%, wins avalanche too here
      expect(order[1].loan.id).toBe("big");
    });
  });

  describe("debtSummary", () => {
    it("computes debt stress score as total EMI / monthly income", async () => {
      mockPrisma.client.loan.findMany.mockResolvedValue([
        { outstandingPrincipal: 500000, emiAmount: 15000 },
        { outstandingPrincipal: 200000, emiAmount: 10000 },
      ]);
      mockIncome.monthlyForecast.mockResolvedValue(100000);

      const summary = await service.debtSummary("user-1");

      expect(summary.totalOutstanding).toBe("700000.00");
      expect(summary.totalMonthlyEmi).toBe("25000.00");
      expect(summary.debtStressScore).toBe(25); // 25000/100000 * 100
    });

    it("returns a zero stress score rather than dividing by zero when there's no income", async () => {
      mockPrisma.client.loan.findMany.mockResolvedValue([{ outstandingPrincipal: 100000, emiAmount: 5000 }]);
      mockIncome.monthlyForecast.mockResolvedValue(0);

      const summary = await service.debtSummary("user-1");

      expect(summary.debtStressScore).toBe(0);
    });
  });

  describe("update / remove (atomic ownership hardening)", () => {
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.loan.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.loan.findUnique.mockResolvedValue({ id: "l1", lender: "Updated Bank" });

      const result = await service.update("user-1", "l1", { lender: "Updated Bank" } as any);

      expect(mockPrisma.client.loan.updateMany).toHaveBeenCalledWith({
        where: { id: "l1", userId: "user-1" },
        data: { lender: "Updated Bank", startDate: undefined },
      });
      expect(result).toEqual({ id: "l1", lender: "Updated Bank" });
    });

    it("throws NotFoundException on update without leaking whether the id exists for another user", async () => {
      mockPrisma.client.loan.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
    });

    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.loan.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "l1");

      expect(mockPrisma.client.loan.deleteMany).toHaveBeenCalledWith({ where: { id: "l1", userId: "user-1" } });
      expect(result).toEqual({ id: "l1" });
    });

    it("throws NotFoundException on remove when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.loan.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });
});
