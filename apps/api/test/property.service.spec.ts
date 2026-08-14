import { Test } from "@nestjs/testing";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { PropertyService } from "../src/property/property.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { LoansService } from "../src/loans/loans.service";
import { IncomeService } from "../src/income/income.service";
import { currentFinancialYear } from "../src/common/utils/financial-year.util";

describe("PropertyService.portfolioSummary metrics", () => {
  let service: PropertyService;
  const mockPrisma = {
    client: {
      property: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      loan: { findUnique: jest.fn() },
      insurancePolicy: { findUnique: jest.fn() },
    },
  };
  const mockLoans = { amortizationSchedule: jest.fn() };
  const mockIncomeService = { create: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PropertyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LoansService, useValue: mockLoans },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(PropertyService);
  });

  it("computes equity as current value minus linked loan outstanding", async () => {
    mockPrisma.client.property.findMany.mockResolvedValue([
      {
        id: "p1",
        currentValue: 6000000,
        purchasePrice: 5000000,
        monthlyRentalIncome: null,
        annualMaintenanceCost: 20000,
        annualPropertyTax: 15000,
        loan: { outstandingPrincipal: 3500000 },
      },
    ]);

    const summary = await service.portfolioSummary("user-1");

    expect(summary.properties[0].metrics.equity).toBe("2500000.00");
    expect(summary.properties[0].metrics.appreciationPercent).toBe(20); // (6M-5M)/5M
    expect(summary.properties[0].metrics.rentalYieldPercent).toBeNull();
  });

  it("computes rental yield only when rental income is set, and treats no-loan properties as fully owned equity", async () => {
    mockPrisma.client.property.findMany.mockResolvedValue([
      {
        id: "p2",
        currentValue: 4000000,
        purchasePrice: 4000000,
        monthlyRentalIncome: 20000,
        annualMaintenanceCost: 10000,
        annualPropertyTax: 8000,
        loan: null,
      },
    ]);

    const summary = await service.portfolioSummary("user-1");
    const metrics = summary.properties[0].metrics;

    expect(metrics.linkedLoanOutstanding).toBeNull();
    expect(metrics.equity).toBe("4000000.00"); // no loan -> full current value is equity
    expect(metrics.rentalYieldPercent).toBe(6); // (20000*12)/4000000 * 100
    // netAnnualCarryCost = maintenance(10000) + tax(8000) - annualRent(240000) = -222000 (net positive cashflow)
    expect(metrics.netAnnualCarryCost).toBe("-222000.00");
  });

  it("sums portfolio totals across multiple properties", async () => {
    mockPrisma.client.property.findMany.mockResolvedValue([
      { id: "p1", currentValue: 3000000, purchasePrice: 2500000, monthlyRentalIncome: null, annualMaintenanceCost: 0, annualPropertyTax: 0, loan: { outstandingPrincipal: 1000000 } },
      { id: "p2", currentValue: 2000000, purchasePrice: 2000000, monthlyRentalIncome: null, annualMaintenanceCost: 0, annualPropertyTax: 0, loan: null },
    ]);

    const summary = await service.portfolioSummary("user-1");

    expect(summary.totalCurrentValue).toBe("5000000.00");
    expect(summary.totalEquity).toBe("4000000.00"); // (3M-1M) + 2M
  });
});

describe("PropertyService.estimateHomeLoanInterestDeduction (new)", () => {
  let service: PropertyService;
  const mockPrisma = {
    client: {
      property: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      loan: { findUnique: jest.fn() },
      insurancePolicy: { findUnique: jest.fn() },
    },
  };
  const mockLoans = { amortizationSchedule: jest.fn() };
  const mockIncomeService = { create: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PropertyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LoansService, useValue: mockLoans },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(PropertyService);
  });

  function makeSchedule(months: number, interestPerRow: number) {
    return Array.from({ length: months }, (_, i) => ({
      month: i + 1,
      emi: interestPerRow + 1000,
      interest: interestPerRow,
      principal: 1000,
      balance: 100000 - i * 1000,
    }));
  }

  it("returns null when the property has no linked loan", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "user-1", type: "HOUSE", loan: null });

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1");

    expect(result).toBeNull();
    expect(mockLoans.amortizationSchedule).not.toHaveBeenCalled();
  });

  it("returns null when the linked loan is not a HOME-type loan", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "HOUSE",
      loan: { id: "l1", type: "PERSONAL" },
    });

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1");

    expect(result).toBeNull();
  });

  it("returns null for a non-residential property type even with a linked HOME loan", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "PLOT",
      loan: { id: "l1", type: "HOME" },
    });

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1");

    expect(result).toBeNull();
  });

  it("throws NotFoundException for a property owned by someone else", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "someone-else" });
    await expect(service.estimateHomeLoanInterestDeduction("user-1", "p1")).rejects.toThrow(NotFoundException);
  });

  it("sums interest only from schedule rows that fall within the target financial year", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "HOUSE",
      loan: { id: "l1", type: "HOME" },
    });
    mockLoans.amortizationSchedule.mockResolvedValue(makeSchedule(24, 1000)); // 2 years, ₹1000 interest/month flat

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1", currentFinancialYear());

    expect(result).not.toBeNull();
    expect(result!.monthsIncluded).toBeGreaterThan(0);
    expect(result!.monthsIncluded).toBeLessThanOrEqual(12);
    // Every included row contributes exactly ₹1000 — the two figures must be
    // internally consistent regardless of which calendar date the test happens to run on.
    expect(Number(result!.estimatedInterestPayable)).toBeCloseTo(result!.monthsIncluded * 1000, 2);
  });

  it("returns zero months/interest for a financial year far outside the schedule's horizon", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "APARTMENT",
      loan: { id: "l1", type: "HOME" },
    });
    mockLoans.amortizationSchedule.mockResolvedValue(makeSchedule(24, 1000));

    // A financial year decades in the future can't overlap a 24-month schedule
    // projected from today, regardless of what "today" actually is when this test runs.
    const farFutureFy = currentFinancialYear(new Date(2099, 5, 1));
    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1", farFutureFy);

    expect(result!.monthsIncluded).toBe(0);
    expect(result!.estimatedInterestPayable).toBe("0.00");
  });

  it("flags exceedsSelfOccupiedCap when estimated interest is above ₹2,00,000", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "HOUSE",
      loan: { id: "l1", type: "HOME" },
    });
    // High monthly interest guarantees the FY total exceeds the ₹200,000 cap regardless
    // of exactly how many months of the current FY the schedule happens to cover.
    mockLoans.amortizationSchedule.mockResolvedValue(makeSchedule(24, 50000));

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1", currentFinancialYear());

    expect(result!.exceedsSelfOccupiedCap).toBe(true);
    expect(result!.selfOccupiedCap).toBe("200000.00");
  });

  it("includes a RENTAL property (let-out residential) as Section 24 eligible", async () => {
    mockPrisma.client.property.findUnique.mockResolvedValue({
      id: "p1", userId: "user-1", type: "RENTAL",
      loan: { id: "l1", type: "HOME" },
    });
    mockLoans.amortizationSchedule.mockResolvedValue(makeSchedule(12, 1000));

    const result = await service.estimateHomeLoanInterestDeduction("user-1", "p1", currentFinancialYear());

    expect(result).not.toBeNull();
  });
});

describe("PropertyService CRUD hardening", () => {
  let service: PropertyService;
  const mockPrisma = {
    client: {
      property: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      loan: { findUnique: jest.fn() },
      insurancePolicy: { findUnique: jest.fn() },
      // income added for the new remove()-cleanup / update()-sync-consistency tests
      // below (audit item #10 follow-through) — the pre-existing tests above never
      // reference it, so this is purely additive to the mock shape.
      income: { deleteMany: jest.fn(), updateMany: jest.fn() },
    },
  };
  const mockLoans = { amortizationSchedule: jest.fn() };
  const mockIncomeService = { create: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PropertyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LoansService, useValue: mockLoans },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(PropertyService);
  });

  describe("update", () => {
    it("verifies a linked loanId belongs to the caller before updating", async () => {
      mockPrisma.client.loan.findUnique.mockResolvedValue({ id: "l1", userId: "someone-else" });

      await expect(service.update("user-1", "p1", { loanId: "l1" } as any)).rejects.toThrow();
      expect(mockPrisma.client.property.updateMany).not.toHaveBeenCalled();
    });

    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.property.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", name: "Updated" });

      const result = await service.update("user-1", "p1", { name: "Updated" } as any);

      expect(mockPrisma.client.property.updateMany).toHaveBeenCalledWith({
        where: { id: "p1", userId: "user-1" },
        data: { name: "Updated", purchaseDate: undefined },
      });
      expect(result).toEqual({ id: "p1", name: "Updated" });
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.property.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.property.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.property.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "p1");

      expect(mockPrisma.client.property.deleteMany).toHaveBeenCalledWith({
        where: { id: "p1", userId: "user-1" },
      });
      expect(result).toEqual({ id: "p1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.property.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });

    it("also deletes the linked rent-sync Income row when removing a synced property", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "user-1", rentSyncedIncomeId: "income-1" });
      mockPrisma.client.property.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.income.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove("user-1", "p1");

      expect(mockPrisma.client.income.deleteMany).toHaveBeenCalledWith({ where: { id: "income-1", userId: "user-1" } });
    });

    it("does not attempt an Income cleanup when the removed property was never synced", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "user-1", rentSyncedIncomeId: null });
      mockPrisma.client.property.deleteMany.mockResolvedValue({ count: 1 });

      await service.remove("user-1", "p1");

      expect(mockPrisma.client.income.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("update — keeps a synced rent Income row's amount aligned (new, audit item #10 follow-through)", () => {
    it("updates the linked Income row's amount when monthlyRentalIncome changes on a synced property", async () => {
      mockPrisma.client.property.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", rentSyncedIncomeId: "income-1", monthlyRentalIncome: 30000 });
      mockPrisma.client.income.updateMany.mockResolvedValue({ count: 1 });

      await service.update("user-1", "p1", { monthlyRentalIncome: 30000 } as any);

      expect(mockPrisma.client.income.updateMany).toHaveBeenCalledWith({
        where: { id: "income-1", userId: "user-1" },
        data: { amount: 30000 },
      });
    });

    it("does not touch Income when monthlyRentalIncome isn't part of the update", async () => {
      mockPrisma.client.property.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", rentSyncedIncomeId: "income-1", name: "Updated" });

      await service.update("user-1", "p1", { name: "Updated" } as any);

      expect(mockPrisma.client.income.updateMany).not.toHaveBeenCalled();
    });

    it("does not touch Income when the property isn't synced, even if monthlyRentalIncome changes", async () => {
      mockPrisma.client.property.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", rentSyncedIncomeId: null, monthlyRentalIncome: 30000 });

      await service.update("user-1", "p1", { monthlyRentalIncome: 30000 } as any);

      expect(mockPrisma.client.income.updateMany).not.toHaveBeenCalled();
    });
  });
});

describe("PropertyService.enableRentIncomeSync / disableRentIncomeSync (new, audit item #10)", () => {
  let service: PropertyService;
  const mockPrisma = {
    client: {
      property: { findUnique: jest.fn(), update: jest.fn() },
      income: { deleteMany: jest.fn() },
    },
  };
  const mockLoans = { amortizationSchedule: jest.fn() };
  const mockIncomeService = { create: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        PropertyService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: LoansService, useValue: mockLoans },
        { provide: IncomeService, useValue: mockIncomeService },
      ],
    }).compile();
    service = moduleRef.get(PropertyService);
  });

  describe("enableRentIncomeSync", () => {
    it("creates a MONTHLY RENT-source Income row and links it back to the property", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({
        id: "p1",
        userId: "user-1",
        name: "Sea View Apartment",
        address: "Bandra West",
        isRented: true,
        monthlyRentalIncome: 45000,
        rentSyncedIncomeId: null,
      });
      mockIncomeService.create.mockResolvedValue({ id: "income-1", amount: 45000 });
      mockPrisma.client.property.update.mockResolvedValue({ id: "p1", rentSyncedIncomeId: "income-1" });

      const result = await service.enableRentIncomeSync("user-1", "p1");

      expect(mockIncomeService.create).toHaveBeenCalledWith(
        "user-1",
        expect.objectContaining({ source: "RENT", recurrence: "MONTHLY", amount: 45000, label: expect.stringContaining("Sea View Apartment") }),
      );
      expect(mockPrisma.client.property.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { rentSyncedIncomeId: "income-1" },
      });
      expect(result.income.id).toBe("income-1");
    });

    it("rejects a property that isn't marked as rented", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({
        id: "p1", userId: "user-1", isRented: false, monthlyRentalIncome: 45000, rentSyncedIncomeId: null,
      });

      await expect(service.enableRentIncomeSync("user-1", "p1")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.create).not.toHaveBeenCalled();
    });

    it("rejects a property with no positive monthlyRentalIncome", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({
        id: "p1", userId: "user-1", isRented: true, monthlyRentalIncome: null, rentSyncedIncomeId: null,
      });

      await expect(service.enableRentIncomeSync("user-1", "p1")).rejects.toThrow(BadRequestException);
    });

    it("rejects a property whose rent is already synced (idempotency)", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({
        id: "p1", userId: "user-1", isRented: true, monthlyRentalIncome: 45000, rentSyncedIncomeId: "income-existing",
      });

      await expect(service.enableRentIncomeSync("user-1", "p1")).rejects.toThrow(BadRequestException);
      expect(mockIncomeService.create).not.toHaveBeenCalled();
    });

    it("throws NotFoundException for a property owned by someone else", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "someone-else" });
      await expect(service.enableRentIncomeSync("user-1", "p1")).rejects.toThrow(NotFoundException);
    });
  });

  describe("disableRentIncomeSync", () => {
    it("deletes the linked Income row and clears rentSyncedIncomeId", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "user-1", rentSyncedIncomeId: "income-1" });
      mockPrisma.client.income.deleteMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.property.update.mockResolvedValue({ id: "p1", rentSyncedIncomeId: null });

      await service.disableRentIncomeSync("user-1", "p1");

      expect(mockPrisma.client.income.deleteMany).toHaveBeenCalledWith({ where: { id: "income-1", userId: "user-1" } });
      expect(mockPrisma.client.property.update).toHaveBeenCalledWith({
        where: { id: "p1" },
        data: { rentSyncedIncomeId: null },
      });
    });

    it("rejects a property whose rent was never synced", async () => {
      mockPrisma.client.property.findUnique.mockResolvedValue({ id: "p1", userId: "user-1", rentSyncedIncomeId: null });

      await expect(service.disableRentIncomeSync("user-1", "p1")).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.income.deleteMany).not.toHaveBeenCalled();
    });
  });
});
