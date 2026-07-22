import { Test } from "@nestjs/testing";
import { UsersService } from "../src/users/users.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";

describe("UsersService", () => {
  let service: UsersService;
  const mockPrisma = {
    client: {
      user: { update: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
      income: { findMany: jest.fn() },
      expense: { findMany: jest.fn() },
    },
  };
  const mockAudit = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    service = moduleRef.get(UsersService);
  });

  it("updateProfile writes only the given fields and logs an audit entry", async () => {
    mockPrisma.client.user.update.mockResolvedValue({ id: "user-1", name: "New Name" });

    await service.updateProfile("user-1", { name: "New Name" });

    expect(mockPrisma.client.user.update).toHaveBeenCalledWith({ where: { id: "user-1" }, data: { name: "New Name" } });
    expect(mockAudit.log).toHaveBeenCalledWith("profile_updated", "user-1", { fields: ["name"] });
  });

  it("exportData bundles user profile, incomes, and expenses scoped to that user only", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockPrisma.client.income.findMany.mockResolvedValue([{ id: "i1" }]);
    mockPrisma.client.expense.findMany.mockResolvedValue([{ id: "e1" }]);

    const result = await service.exportData("user-1");

    expect(mockPrisma.client.income.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.expense.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(result.incomes).toEqual([{ id: "i1" }]);
    expect(result.exportedAt).toBeDefined();
    expect(mockAudit.log).toHaveBeenCalledWith("data_export_requested", "user-1");
  });

  it("deleteAccount deletes exactly the requesting user's row", async () => {
    await service.deleteAccount("user-1");
    expect(mockPrisma.client.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
  });
});
