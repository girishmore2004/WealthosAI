import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { ExpensesService } from "../src/expenses/expenses.service";
import { PrismaService } from "../src/prisma/prisma.service";

describe("ExpensesService.create — expenses are actual spending only", () => {
  let service: ExpensesService;
  const mockPrisma = {
    client: {
      category: { findUnique: jest.fn() },
      expense: { create: jest.fn() },
    },
  };
  const dto = {
    categoryId: "c1",
    amount: 10000,
    spentAt: new Date().toISOString(),
    paymentMethod: "UPI" as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [ExpensesService, { provide: PrismaService, useValue: mockPrisma }],
    }).compile();
    service = moduleRef.get(ExpensesService);
  });

  it("rejects a new expense in a SAVINGS category (SIP / emergency fund)", async () => {
    mockPrisma.client.category.findUnique.mockResolvedValue({ type: "SAVINGS", name: "SIP Investment" });
    await expect(service.create("user-1", dto)).rejects.toBeInstanceOf(BadRequestException);
    expect(mockPrisma.client.expense.create).not.toHaveBeenCalled();
  });

  it("rejects an unknown category with a clear 400 instead of an opaque FK failure", async () => {
    mockPrisma.client.category.findUnique.mockResolvedValue(null);
    await expect(service.create("user-1", dto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("still creates a normal NEED/WANT expense", async () => {
    mockPrisma.client.category.findUnique.mockResolvedValue({ type: "NEED", name: "Rent" });
    mockPrisma.client.expense.create.mockResolvedValue({ id: "e1" });
    await expect(service.create("user-1", dto)).resolves.toEqual({ id: "e1" });
  });
});
