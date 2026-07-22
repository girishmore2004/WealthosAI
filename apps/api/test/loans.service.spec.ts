import { Test } from "@nestjs/testing";
import { LoansService } from "../src/loans/loans.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("LoansService", () => {
  let service: LoansService;
  const mockPrisma = { client: { loan: { findMany: jest.fn(), findUnique: jest.fn() } } };
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
});
