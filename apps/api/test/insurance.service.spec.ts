import { Test } from "@nestjs/testing";
import { NotFoundException, BadRequestException } from "@nestjs/common";
import { InsuranceService } from "../src/insurance/insurance.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";

describe("InsuranceService.gapAnalysis", () => {
  let service: InsuranceService;
  const mockPrisma = {
    client: {
      insurancePolicy: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn() },
      user: { findUnique: jest.fn() },
      // New for the gap-analysis expansion: HOME and BUSINESS benchmarks read these
      // tables directly (read-only, no PropertyService/BusinessService import — same
      // pattern this file already used for the household/dependents lookup).
      property: { findMany: jest.fn() },
      business: { findMany: jest.fn() },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.user.findUnique.mockResolvedValue({ household: { dependents: [] } });
    // Defaults to "owns no property, no tracked business" so the 4 original tests below
    // (which predate HOME/BUSINESS support and don't care about them) get exactly the
    // same TERM/HEALTH/PERSONAL_ACCIDENT/CRITICAL_ILLNESS-only behavior as before,
    // without needing any changes to their own bodies.
    mockPrisma.client.property.findMany.mockResolvedValue([]);
    mockPrisma.client.business.findMany.mockResolvedValue([]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        InsuranceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
      ],
    }).compile();
    service = moduleRef.get(InsuranceService);
  });

  it("flags a complete absence of term coverage as a significant gap (10x income benchmark)", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
    mockIncome.monthlyForecast.mockResolvedValue(100000); // 12L/year

    const gaps = await service.gapAnalysis("user-1");
    const term = gaps.find((g) => g.type === "TERM")!;

    expect(term.hasCoverage).toBe(false);
    expect(Number(term.recommendedCoverage)).toBeCloseTo(12000000, 0); // 10x annual income
    expect(term.message).toMatch(/no term life policy found/i);
  });

  it("marks coverage adequate (zero gap) when it meets or exceeds the benchmark", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([{ type: "TERM", coverageAmount: 15000000 }]);
    mockIncome.monthlyForecast.mockResolvedValue(100000);

    const gaps = await service.gapAnalysis("user-1");
    const term = gaps.find((g) => g.type === "TERM")!;

    expect(term.hasCoverage).toBe(true);
    expect(term.gap).toBe("0.00");
  });

  it("increases the recommended health coverage benchmark per dependent", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
    mockIncome.monthlyForecast.mockResolvedValue(50000);
    mockPrisma.client.user.findUnique.mockResolvedValue({ household: { dependents: [{}, {}] } }); // 2 dependents

    const gaps = await service.gapAnalysis("user-1");
    const health = gaps.find((g) => g.type === "HEALTH")!;

    // base 500000 + 2 * 300000 = 1100000
    expect(Number(health.recommendedCoverage)).toBeCloseTo(1100000, 0);
  });

  it("sums coverage across multiple policies of the same type before comparing to the benchmark", async () => {
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([
      { type: "HEALTH", coverageAmount: 300000 },
      { type: "HEALTH", coverageAmount: 300000 },
    ]);
    mockIncome.monthlyForecast.mockResolvedValue(50000);

    const gaps = await service.gapAnalysis("user-1");
    const health = gaps.find((g) => g.type === "HEALTH")!;

    expect(Number(health.currentCoverage)).toBe(600000);
  });

  describe("coverage expansion (new)", () => {
    it("always includes a CRITICAL_ILLNESS benchmark at 50% of annual income, regardless of asset ownership", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(100000); // 12L/year

      const gaps = await service.gapAnalysis("user-1");
      const ci = gaps.find((g) => g.type === "CRITICAL_ILLNESS")!;

      expect(ci).toBeDefined();
      expect(ci.hasCoverage).toBe(false);
      expect(Number(ci.recommendedCoverage)).toBeCloseTo(600000, 0); // 12L annual * 0.5
    });

    it("does not include a HOME gap entry for a user who owns no property", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.property.findMany.mockResolvedValue([]);

      const gaps = await service.gapAnalysis("user-1");

      expect(gaps.find((g) => g.type === "HOME")).toBeUndefined();
    });

    it("benchmarks HOME coverage against total property value for a property owner", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.property.findMany.mockResolvedValue([
        { currentValue: 8000000 },
        { currentValue: 2000000 },
      ]);

      const gaps = await service.gapAnalysis("user-1");
      const home = gaps.find((g) => g.type === "HOME")!;

      expect(home).toBeDefined();
      expect(Number(home.recommendedCoverage)).toBe(10000000); // sum of both properties
      expect(home.hasCoverage).toBe(false);
    });

    it("recognizes existing HOME coverage against the property-value benchmark", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([{ type: "HOME", coverageAmount: 9000000 }]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.property.findMany.mockResolvedValue([{ currentValue: 8000000 }]);

      const gaps = await service.gapAnalysis("user-1");
      const home = gaps.find((g) => g.type === "HOME")!;

      expect(home.hasCoverage).toBe(true);
      expect(home.gap).toBe("0.00"); // 9M covered >= 8M benchmark
    });

    it("does not include a BUSINESS gap entry for a user with no tracked business", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.business.findMany.mockResolvedValue([]);

      const gaps = await service.gapAnalysis("user-1");

      expect(gaps.find((g) => g.type === "BUSINESS")).toBeUndefined();
    });

    it("flags BUSINESS as a presence-only gap (no numeric benchmark) for a business owner with no business policy", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.business.findMany.mockResolvedValue([{ id: "biz-1" }]);

      const gaps = await service.gapAnalysis("user-1");
      const business = gaps.find((g) => g.type === "BUSINESS")!;

      expect(business).toBeDefined();
      expect(business.hasCoverage).toBe(false);
      expect(business.recommendedCoverage).toBe("0.00"); // deliberately no invented amount
      expect(business.gap).toBe("0.00");
    });

    it("recognizes an existing BUSINESS policy and does not flag it as a gap", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([{ type: "BUSINESS", coverageAmount: 500000 }]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);
      mockPrisma.client.business.findMany.mockResolvedValue([{ id: "biz-1" }]);

      const gaps = await service.gapAnalysis("user-1");
      const business = gaps.find((g) => g.type === "BUSINESS")!;

      expect(business.hasCoverage).toBe(true);
    });

    it("never generates VEHICLE or TRAVEL gap entries (no defensible benchmark or ownership signal)", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
      mockIncome.monthlyForecast.mockResolvedValue(50000);

      const gaps = await service.gapAnalysis("user-1");

      expect(gaps.find((g) => g.type === "VEHICLE")).toBeUndefined();
      expect(gaps.find((g) => g.type === "TRAVEL")).toBeUndefined();
    });
  });
});

describe("InsuranceService CRUD hardening", () => {
  let service: InsuranceService;
  const mockPrisma = {
    client: {
      insurancePolicy: { findMany: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn(), create: jest.fn() },
      user: { findUnique: jest.fn() },
      property: { findMany: jest.fn() },
      business: { findMany: jest.fn() },
      // dependent added for the nominee-link ownership check below (audit item #13) —
      // the pre-existing tests in this block never set nomineeDependentId, so
      // assertDependentOwnership() short-circuits before touching this mock, and every
      // existing assertion is unaffected.
      dependent: { findUnique: jest.fn() },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        InsuranceService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
      ],
    }).compile();
    service = moduleRef.get(InsuranceService);
  });

  describe("update", () => {
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.insurancePolicy.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.insurancePolicy.findUnique.mockResolvedValue({ id: "p1", provider: "Updated Insurer" });

      const result = await service.update("user-1", "p1", { provider: "Updated Insurer" } as any);

      expect(mockPrisma.client.insurancePolicy.updateMany).toHaveBeenCalledWith({
        where: { id: "p1", userId: "user-1" },
        data: { provider: "Updated Insurer", renewalDate: undefined },
      });
      expect(result).toEqual({ id: "p1", provider: "Updated Insurer" });
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.insurancePolicy.updateMany.mockResolvedValue({ count: 0 });
      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.insurancePolicy.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.insurancePolicy.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "p1");

      expect(mockPrisma.client.insurancePolicy.deleteMany).toHaveBeenCalledWith({
        where: { id: "p1", userId: "user-1" },
      });
      expect(result).toEqual({ id: "p1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.insurancePolicy.deleteMany.mockResolvedValue({ count: 0 });
      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });

  describe("nominee-dependent linking (new, audit item #13)", () => {
    it("allows linking a nominee to a dependent in the caller's own household", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "h1" });
      mockPrisma.client.dependent.findUnique.mockResolvedValue({ id: "dep-1", householdId: "h1" });
      mockPrisma.client.insurancePolicy.create.mockResolvedValue({ id: "p1", nomineeDependentId: "dep-1" });

      await service.create("user-1", {
        type: "TERM",
        provider: "HDFC Ergo",
        premiumAmount: 10000,
        premiumFrequency: "YEARLY",
        coverageAmount: 5000000,
        renewalDate: "2027-01-01",
        nomineeDependentId: "dep-1",
      } as any);

      expect(mockPrisma.client.insurancePolicy.create).toHaveBeenCalled();
    });

    it("rejects linking a nominee to a dependent in a different household", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "h1" });
      mockPrisma.client.dependent.findUnique.mockResolvedValue({ id: "dep-1", householdId: "someone-elses-household" });

      await expect(
        service.create("user-1", {
          type: "TERM",
          provider: "HDFC Ergo",
          premiumAmount: 10000,
          premiumFrequency: "YEARLY",
          coverageAmount: 5000000,
          renewalDate: "2027-01-01",
          nomineeDependentId: "dep-1",
        } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.insurancePolicy.create).not.toHaveBeenCalled();
    });

    it("rejects linking a nominee to a dependent that doesn't exist", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "h1" });
      mockPrisma.client.dependent.findUnique.mockResolvedValue(null);

      await expect(
        service.update("user-1", "p1", { nomineeDependentId: "missing-dep" } as any),
      ).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.insurancePolicy.updateMany).not.toHaveBeenCalled();
    });

    it("rejects linking a nominee when the caller has no household at all", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: null });
      mockPrisma.client.dependent.findUnique.mockResolvedValue({ id: "dep-1", householdId: "h1" });

      await expect(
        service.update("user-1", "p1", { nomineeDependentId: "dep-1" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("skips the ownership check entirely when nomineeDependentId isn't part of the request", async () => {
      mockPrisma.client.insurancePolicy.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.insurancePolicy.findUnique.mockResolvedValue({ id: "p1" });

      await service.update("user-1", "p1", { provider: "New Provider" } as any);

      expect(mockPrisma.client.user.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.client.dependent.findUnique).not.toHaveBeenCalled();
    });

    it("allows explicitly un-linking a nominee (nomineeDependentId: null) without triggering the ownership check", async () => {
      mockPrisma.client.insurancePolicy.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.insurancePolicy.findUnique.mockResolvedValue({ id: "p1", nomineeDependentId: null });

      await service.update("user-1", "p1", { nomineeDependentId: null } as any);

      expect(mockPrisma.client.dependent.findUnique).not.toHaveBeenCalled();
      expect(mockPrisma.client.insurancePolicy.updateMany).toHaveBeenCalledWith({
        where: { id: "p1", userId: "user-1" },
        data: expect.objectContaining({ nomineeDependentId: null }),
      });
    });
  });

  describe("nomineeSummary (audit item #13 follow-through)", () => {
    it("counts a policy with only a linked dependent (no free-text name) as having a nominee", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([
        { id: "p1", provider: "A", type: "TERM", nomineeName: null, nomineeDependentId: "dep-1" },
      ]);

      const summary = await service.nomineeSummary("user-1");

      expect(summary.withNominee).toBe(1);
      expect(summary.missingNominee).toHaveLength(0);
      expect(summary.linkedToDependent).toBe(1);
    });

    it("still flags a policy with neither a name nor a link as missing a nominee", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([
        { id: "p1", provider: "A", type: "TERM", nomineeName: null, nomineeDependentId: null },
      ]);

      const summary = await service.nomineeSummary("user-1");

      expect(summary.withNominee).toBe(0);
      expect(summary.missingNominee).toHaveLength(1);
      expect(summary.linkedToDependent).toBe(0);
    });

    it("counts free-text-only nominees as having a nominee but not linked", async () => {
      mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([
        { id: "p1", provider: "A", type: "TERM", nomineeName: "Jane Doe", nomineeDependentId: null },
      ]);

      const summary = await service.nomineeSummary("user-1");

      expect(summary.withNominee).toBe(1);
      expect(summary.linkedToDependent).toBe(0);
    });
  });
});
