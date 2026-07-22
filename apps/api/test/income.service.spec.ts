import { Test } from "@nestjs/testing";
import { IncomeService } from "../src/income/income.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("IncomeService.monthlyForecast", () => {
  let service: IncomeService;
  const mockPrisma = { client: { income: { findMany: jest.fn() } } };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [IncomeService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(IncomeService);
  });

  it("counts a MONTHLY income at full value", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 90000, recurrence: "MONTHLY" }]);
    expect(await service.monthlyForecast("user-1")).toBe(90000);
  });

  it("excludes ONE_TIME income entirely from the recurring monthly forecast", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([
      { amount: 90000, recurrence: "MONTHLY" },
      { amount: 500000, recurrence: "ONE_TIME" },
    ]);
    expect(await service.monthlyForecast("user-1")).toBe(90000);
  });

  it("prorates YEARLY income down to a monthly figure", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 1200000, recurrence: "YEARLY" }]);
    expect(await service.monthlyForecast("user-1")).toBeCloseTo(100000, 0);
  });

  it("prorates WEEKLY income up to a monthly figure (~4.33 weeks/month)", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 5000, recurrence: "WEEKLY" }]);
    expect(await service.monthlyForecast("user-1")).toBeCloseTo(21650, -1);
  });

  it("sums multiple recurring incomes of different frequencies correctly", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([
      { amount: 90000, recurrence: "MONTHLY" },
      { amount: 12000, recurrence: "QUARTERLY" }, // 4000/mo
    ]);
    expect(await service.monthlyForecast("user-1")).toBeCloseTo(94000, 0);
  });

  it("returns 0 rather than NaN when there's no income logged", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([]);
    expect(await service.monthlyForecast("user-1")).toBe(0);
  });
});
