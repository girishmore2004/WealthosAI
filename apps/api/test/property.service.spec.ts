import { Test } from "@nestjs/testing";
import { PropertyService } from "../src/property/property.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("PropertyService.portfolioSummary metrics", () => {
  let service: PropertyService;
  const mockPrisma = {
    client: {
      property: { findMany: jest.fn() },
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [PropertyService, { provide: PrismaService, useValue: mockPrisma }],
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
