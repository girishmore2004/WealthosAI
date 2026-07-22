import { Test } from "@nestjs/testing";
import { InvestmentsService } from "../src/investments/investments.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("InvestmentsService.summary", () => {
  let service: InvestmentsService;
  const mockPrisma = { client: { investment: { findMany: jest.fn() } } };

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
  const mockPrisma = { client: { investment: { findMany: jest.fn() } } };

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
});
