import { Test } from "@nestjs/testing";
import { UsersService } from "../src/users/users.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";

describe("UsersService", () => {
  let service: UsersService;
  // Deliberately does NOT define session/otpCode/aiJob/aiEmbeddingChunk/aiInteractionLog
  // mocks — exportData() must never touch those models (see the exclusion rationale in
  // users.service.ts). If a future change accidentally queries one of them, this mock
  // will throw "not a function" and fail the test below, rather than silently passing.
  const mockPrisma = {
    client: {
      user: { update: jest.fn(), findUnique: jest.fn(), delete: jest.fn() },
      income: { findMany: jest.fn() },
      expense: { findMany: jest.fn() },
      goal: { findMany: jest.fn() },
      investment: { findMany: jest.fn() },
      loan: { findMany: jest.fn() },
      insurancePolicy: { findMany: jest.fn() },
      taxDeduction: { findMany: jest.fn() },
      retirementProfile: { findUnique: jest.fn() },
      property: { findMany: jest.fn() },
      business: { findMany: jest.fn() },
      document: { findMany: jest.fn() },
      alert: { findMany: jest.fn() },
      budget: { findMany: jest.fn() },
      userSettings: { findUnique: jest.fn() },
      auditLog: { findMany: jest.fn() },
      coachInteraction: { findMany: jest.fn() },
      savedScenario: { findMany: jest.fn() },
      agenticCoachRun: { findMany: jest.fn() },
      scenarioStudioRun: { findMany: jest.fn() },
      mlInsightRun: { findMany: jest.fn() },
      ingestionBatch: { findMany: jest.fn() },
      aiSearchLog: { findMany: jest.fn() },
    },
  };
  const mockAudit = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    // Every findMany defaults to [] and every findUnique to null so a test that only
    // cares about one or two fields doesn't have to stub all ~20 queries individually.
    mockPrisma.client.income.findMany.mockResolvedValue([]);
    mockPrisma.client.expense.findMany.mockResolvedValue([]);
    mockPrisma.client.goal.findMany.mockResolvedValue([]);
    mockPrisma.client.investment.findMany.mockResolvedValue([]);
    mockPrisma.client.loan.findMany.mockResolvedValue([]);
    mockPrisma.client.insurancePolicy.findMany.mockResolvedValue([]);
    mockPrisma.client.taxDeduction.findMany.mockResolvedValue([]);
    mockPrisma.client.retirementProfile.findUnique.mockResolvedValue(null);
    mockPrisma.client.property.findMany.mockResolvedValue([]);
    mockPrisma.client.business.findMany.mockResolvedValue([]);
    mockPrisma.client.document.findMany.mockResolvedValue([]);
    mockPrisma.client.alert.findMany.mockResolvedValue([]);
    mockPrisma.client.budget.findMany.mockResolvedValue([]);
    mockPrisma.client.userSettings.findUnique.mockResolvedValue(null);
    mockPrisma.client.auditLog.findMany.mockResolvedValue([]);
    mockPrisma.client.coachInteraction.findMany.mockResolvedValue([]);
    mockPrisma.client.savedScenario.findMany.mockResolvedValue([]);
    mockPrisma.client.agenticCoachRun.findMany.mockResolvedValue([]);
    mockPrisma.client.scenarioStudioRun.findMany.mockResolvedValue([]);
    mockPrisma.client.mlInsightRun.findMany.mockResolvedValue([]);
    mockPrisma.client.ingestionBatch.findMany.mockResolvedValue([]);
    mockPrisma.client.aiSearchLog.findMany.mockResolvedValue([]);

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

  it("exportData bundles every user-owned data table, scoped to that user only", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1" });
    mockPrisma.client.income.findMany.mockResolvedValue([{ id: "i1" }]);
    mockPrisma.client.expense.findMany.mockResolvedValue([{ id: "e1" }]);
    mockPrisma.client.investment.findMany.mockResolvedValue([{ id: "inv1" }]);
    mockPrisma.client.retirementProfile.findUnique.mockResolvedValue({ id: "rp1", userId: "user-1" });
    mockPrisma.client.ingestionBatch.findMany.mockResolvedValue([{ id: "batch1", items: [] }]);

    const result = await service.exportData("user-1");

    // Spot-check a representative sample of the newly-added tables: every call is
    // scoped by userId (never a bare findMany()), and nested relations are included
    // where they exist so the export is genuinely self-contained.
    expect(mockPrisma.client.income.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.expense.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.goal.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.investment.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.loan.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.insurancePolicy.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.taxDeduction.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.retirementProfile.findUnique).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.property.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.business.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      include: { transactions: true, obligations: true },
    });
    expect(mockPrisma.client.document.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.alert.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.budget.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.userSettings.findUnique).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.auditLog.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.coachInteraction.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.savedScenario.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.agenticCoachRun.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.scenarioStudioRun.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.mlInsightRun.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });
    expect(mockPrisma.client.ingestionBatch.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      include: { items: true },
    });
    expect(mockPrisma.client.aiSearchLog.findMany).toHaveBeenCalledWith({ where: { userId: "user-1" } });

    expect(result.incomes).toEqual([{ id: "i1" }]);
    expect(result.investments).toEqual([{ id: "inv1" }]);
    expect(result.retirementProfile).toEqual({ id: "rp1", userId: "user-1" });
    expect(result.ingestionBatches).toEqual([{ id: "batch1", items: [] }]);
    expect(result.exportedAt).toBeDefined();
    expect(mockAudit.log).toHaveBeenCalledWith("data_export_requested", "user-1");
  });

  it("deleteAccount deletes exactly the requesting user's row", async () => {
    await service.deleteAccount("user-1");
    expect(mockPrisma.client.user.delete).toHaveBeenCalledWith({ where: { id: "user-1" } });
  });
});
