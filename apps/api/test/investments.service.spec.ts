import { Test } from "@nestjs/testing";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvestmentsService } from "../src/investments/investments.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("InvestmentsService.summary", () => {
  let service: InvestmentsService;
  const mockPrisma = { client: { investment: { findMany: jest.fn() }, goal: { findUnique: jest.fn() } } };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [InvestmentsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(InvestmentsService);
  });

  it("computes total gain/loss and percent correctly across mixed winners and losers", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "MUTUAL_FUND", currentValue: 120000, costBasis: 100000 }, // +20000
      { type: "STOCK", currentValue: 80000, costBasis: 100000 }, // -20000
    ]);

    const summary = await service.summary("user-1");

    expect(summary.totalCurrentValue).toBe("200000.00");
    expect(summary.totalCostBasis).toBe("200000.00");
    expect(summary.totalGainLoss).toBe("0.00"); // gains and losses cancel out
    expect(summary.totalGainLossPercent).toBe(0);
  });

  it("groups allocation by type and sorts descending by value", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "GOLD", currentValue: 30000, costBasis: 30000 },
      { type: "STOCK", currentValue: 150000, costBasis: 100000 },
      { type: "STOCK", currentValue: 50000, costBasis: 50000 },
    ]);

    const summary = await service.summary("user-1");

    expect(summary.allocation[0].type).toBe("STOCK");
    expect(summary.allocation[0].value).toBe(200000); // 150000 + 50000 combined
    expect(summary.allocation[0].percent).toBe(87); // 200000/230000
    expect(summary.allocation[1].type).toBe("GOLD");
  });

  it("returns zeroed totals rather than NaN when the portfolio is empty", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([]);

    const summary = await service.summary("user-1");

    expect(summary.totalCurrentValue).toBe("0.00");
    expect(summary.totalGainLossPercent).toBe(0);
    expect(summary.allocation).toEqual([]);
  });
});

describe("InvestmentsService.rebalance", () => {
  let service: InvestmentsService;
  const mockPrisma = {
    client: { investment: { findMany: jest.fn(), create: jest.fn() }, goal: { findUnique: jest.fn() } },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [InvestmentsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(InvestmentsService);
  });

  it("rejects a target allocation that doesn't sum to 100%", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([{ type: "STOCK", currentValue: 100000 }]);

    await expect(
      service.rebalance("user-1", {
        targets: [
          { type: "STOCK" as any, percent: 50 },
          { type: "GOLD" as any, percent: 40 },
        ],
      }),
    ).rejects.toThrow(/sum to 100/);
  });

  it("rejects rebalancing an empty portfolio with no cash to deploy", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([]);

    await expect(
      service.rebalance("user-1", { targets: [{ type: "STOCK" as any, percent: 100 }] }),
    ).rejects.toThrow(/Nothing to rebalance/);
  });

  it("suggests SELL for an over-weight type and BUY for an under-weight type to hit target", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "STOCK", currentValue: 80000 },
      { type: "GOLD", currentValue: 20000 },
    ]);

    // total = 100000, target 50/50 -> STOCK should be at 50000 (sell 30000), GOLD at
    // 50000 (buy 30000)
    const plan = await service.rebalance("user-1", {
      targets: [
        { type: "STOCK" as any, percent: 50 },
        { type: "GOLD" as any, percent: 50 },
      ],
    });

    const stock = plan.actions.find((a) => a.type === "STOCK")!;
    const gold = plan.actions.find((a) => a.type === "GOLD")!;

    expect(stock.action).toBe("SELL");
    expect(stock.amount).toBeCloseTo(30000);
    expect(gold.action).toBe("BUY");
    expect(gold.amount).toBeCloseTo(30000);
    expect(plan.totalBuy).toBe("30000.00");
    expect(plan.totalSell).toBe("30000.00");
  });

  it("deploys new cash toward under-weight types without requiring any sells", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "STOCK", currentValue: 50000 },
      { type: "GOLD", currentValue: 50000 },
    ]);

    // total after cash = 100000 + 20000 = 120000; 50/50 target -> each should be 60000.
    // STOCK needs +10000, GOLD needs +10000 — both funded entirely by the new cash.
    const plan = await service.rebalance("user-1", {
      targets: [
        { type: "STOCK" as any, percent: 50 },
        { type: "GOLD" as any, percent: 50 },
      ],
      cashAvailable: 20000,
    });

    expect(plan.actions.every((a) => a.action !== "SELL")).toBe(true);
    expect(plan.totalBuy).toBe("20000.00");
    expect(plan.totalSell).toBe("0.00");
  });

  it("holds a no-sell type at its current value instead of suggesting a sell, and flags it as constrained", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([
      { type: "PPF", currentValue: 90000 }, // locked-in, way over its 20% target
      { type: "STOCK", currentValue: 10000 },
    ]);

    const plan = await service.rebalance("user-1", {
      targets: [
        { type: "PPF" as any, percent: 20 },
        { type: "STOCK" as any, percent: 80 },
      ],
      noSellTypes: ["PPF" as any],
    });

    const ppf = plan.actions.find((a) => a.type === "PPF")!;
    expect(ppf.action).toBe("HOLD");
    expect(ppf.amount).toBe(0);
    expect(ppf.constrained).toBe(true);
  });

  it("treats a type with no current holding and a target percent as a full BUY", async () => {
    mockPrisma.client.investment.findMany.mockResolvedValue([{ type: "STOCK", currentValue: 100000 }]);

    const plan = await service.rebalance("user-1", {
      targets: [
        { type: "STOCK" as any, percent: 80 },
        { type: "GOLD" as any, percent: 20 },
      ],
    });

    const gold = plan.actions.find((a) => a.type === "GOLD")!;
    expect(gold.currentValue).toBe(0);
    expect(gold.action).toBe("BUY");
    expect(gold.amount).toBeCloseTo(20000);
  });

  describe("constraint redistribution (new)", () => {
    it("redistributes a constrained type's shortfall proportionally across the remaining sellable types by relative target weight", async () => {
      // Total = 100000. GOLD is no-sell, way over its 10% target (locked at 60000).
      // Remaining pool for STOCK+FD = 100000 - 60000 = 40000, split by their relative
      // target weights (60:30, i.e. 2:1) -> STOCK gets 40000*60/90 ≈ 26666.67, FD gets
      // 40000*30/90 ≈ 13333.33. Before this fix, STOCK/FD would have been computed
      // against their ORIGINAL (unconstrained) targets of 60000/30000 instead — wildly
      // over what's actually available once GOLD is excluded.
      mockPrisma.client.investment.findMany.mockResolvedValue([
        { type: "GOLD", currentValue: 60000 },
        { type: "STOCK", currentValue: 20000 },
        { type: "FD", currentValue: 20000 },
      ]);

      const plan = await service.rebalance("user-1", {
        targets: [
          { type: "GOLD" as any, percent: 10 },
          { type: "STOCK" as any, percent: 60 },
          { type: "FD" as any, percent: 30 },
        ],
        noSellTypes: ["GOLD" as any],
      });

      const gold = plan.actions.find((a) => a.type === "GOLD")!;
      const stock = plan.actions.find((a) => a.type === "STOCK")!;
      const fd = plan.actions.find((a) => a.type === "FD")!;

      expect(gold.constrained).toBe(true);
      expect(gold.action).toBe("HOLD");
      expect(gold.effectiveTargetValue).toBeCloseTo(60000, 1);
      // Raw target is still reported as "what was asked for" even though it's not
      // achievable given the constraint.
      expect(gold.targetValue).toBeCloseTo(10000, 1);

      expect(stock.constrained).toBe(false);
      expect(stock.effectiveTargetValue).toBeCloseTo(26666.67, 1);
      expect(stock.action).toBe("BUY");
      expect(stock.amount).toBeCloseTo(6666.67, 1);

      expect(fd.constrained).toBe(false);
      expect(fd.effectiveTargetValue).toBeCloseTo(13333.33, 1);
      expect(fd.action).toBe("SELL");
      expect(fd.amount).toBeCloseTo(6666.67, 1);

      // The core invariant this fix restores: buys and sells net out against the fixed
      // total even when a type is constrained (previously only guaranteed when nothing
      // was constrained).
      expect(plan.totalBuy).toBe(plan.totalSell);
    });

    it("cascades a second type into a no-sell constraint only after redistribution shrinks its available target (proves the fix is iterative, not a single pass)", async () => {
      // GOLD (no-sell, current 70000, target 10%) is obviously constrained on the first
      // pass. BOND (also no-sell, current 18000, target 20%) is NOT constrained against
      // the FULL total (20% of 100000 = 20000 >= 18000, that's a tiny BUY, not a sell) —
      // but once GOLD is fixed and the remaining pool shrinks to 30000, BOND's
      // renormalized target (30000 * 20/90 ≈ 6666.67) drops below its current 18000,
      // making it newly constrained. A non-iterative (single-pass) implementation would
      // incorrectly suggest a small BUY for BOND instead of recognizing it's now also
      // locked.
      mockPrisma.client.investment.findMany.mockResolvedValue([
        { type: "GOLD", currentValue: 70000 },
        { type: "BOND", currentValue: 18000 },
        { type: "STOCK", currentValue: 12000 },
      ]);

      const plan = await service.rebalance("user-1", {
        targets: [
          { type: "GOLD" as any, percent: 10 },
          { type: "BOND" as any, percent: 20 },
          { type: "STOCK" as any, percent: 70 },
        ],
        noSellTypes: ["GOLD" as any, "BOND" as any],
      });

      const gold = plan.actions.find((a) => a.type === "GOLD")!;
      const bond = plan.actions.find((a) => a.type === "BOND")!;
      const stock = plan.actions.find((a) => a.type === "STOCK")!;

      expect(gold.constrained).toBe(true);
      expect(bond.constrained).toBe(true); // the cascaded constraint this test targets
      expect(bond.action).toBe("HOLD");
      expect(bond.amount).toBe(0);
      expect(stock.constrained).toBe(false);

      // Every type's effective target sums back to the fixed total — the invariant
      // holds even with two layers of constraint.
      const sumEffective = plan.actions.reduce((sum, a) => sum + a.effectiveTargetValue, 0);
      expect(sumEffective).toBeCloseTo(100000, 1);
    });
  });

  describe("goalId ownership", () => {
    it("rejects creating an investment linked to a goal owned by someone else", async () => {
      mockPrisma.client.goal.findUnique.mockResolvedValue({ id: "goal-1", userId: "someone-else" });

      await expect(
        service.create("user-1", { goalId: "goal-1" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("rejects linking to a goalId that doesn't exist at all", async () => {
      mockPrisma.client.goal.findUnique.mockResolvedValue(null);

      await expect(
        service.create("user-1", { goalId: "does-not-exist" } as any),
      ).rejects.toThrow(BadRequestException);
    });

    it("allows creating an investment with no goalId at all", async () => {
      mockPrisma.client.investment.create.mockResolvedValue({ id: "inv-1" });
      await service.create("user-1", {} as any);
      expect(mockPrisma.client.goal.findUnique).not.toHaveBeenCalled();
    });
  });
});

describe("InvestmentsService CRUD hardening", () => {
  let service: InvestmentsService;
  const mockPrisma = {
    client: {
      investment: {
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
      },
      goal: { findUnique: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [InvestmentsService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(InvestmentsService);
  });

  describe("update", () => {
    it("updates and returns the row when it exists and is owned by the caller", async () => {
      mockPrisma.client.investment.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.client.investment.findUnique.mockResolvedValue({ id: "inv-1", name: "Updated" });

      const result = await service.update("user-1", "inv-1", { name: "Updated" } as any);

      expect(mockPrisma.client.investment.updateMany).toHaveBeenCalledWith({
        where: { id: "inv-1", userId: "user-1" },
        data: { name: "Updated", purchaseDate: undefined },
      });
      expect(result).toEqual({ id: "inv-1", name: "Updated" });
    });

    it("throws NotFoundException without leaking whether the id exists for another user", async () => {
      mockPrisma.client.investment.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.update("user-1", "not-mine", {} as any)).rejects.toThrow(NotFoundException);
      expect(mockPrisma.client.investment.findUnique).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("deletes atomically scoped by owner and returns the id", async () => {
      mockPrisma.client.investment.deleteMany.mockResolvedValue({ count: 1 });

      const result = await service.remove("user-1", "inv-1");

      expect(mockPrisma.client.investment.deleteMany).toHaveBeenCalledWith({
        where: { id: "inv-1", userId: "user-1" },
      });
      expect(result).toEqual({ id: "inv-1" });
    });

    it("throws NotFoundException when the id doesn't exist or isn't owned by the caller", async () => {
      mockPrisma.client.investment.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.remove("user-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });

  describe("listPaged", () => {
    it("applies default page/pageSize and returns a paging envelope", async () => {
      mockPrisma.client.investment.findMany.mockResolvedValue([{ id: "inv-1" }]);
      mockPrisma.client.investment.count.mockResolvedValue(1);

      const result = await service.listPaged("user-1", {});

      expect(mockPrisma.client.investment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1" }, skip: 0, take: 25 }),
      );
      expect(result).toEqual({ items: expect.any(Array), total: 1, page: 1, pageSize: 25, totalPages: 1 });
    });

    it("applies a type filter when provided", async () => {
      mockPrisma.client.investment.findMany.mockResolvedValue([]);
      mockPrisma.client.investment.count.mockResolvedValue(0);

      await service.listPaged("user-1", { type: "GOLD" as any });

      expect(mockPrisma.client.investment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: "user-1", type: "GOLD" } }),
      );
    });
  });
});
