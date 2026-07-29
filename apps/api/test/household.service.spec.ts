import { Test } from "@nestjs/testing";
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { HouseholdService } from "../src/household/household.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { IncomeService } from "../src/income/income.service";
import { ExpensesService } from "../src/expenses/expenses.service";
import { InvestmentsService } from "../src/investments/investments.service";
import { LoansService } from "../src/loans/loans.service";
import { PropertyService } from "../src/property/property.service";
import { GoalsService } from "../src/goals/goals.service";
import { BusinessService } from "../src/business/business.service";
import { AlertsService } from "../src/alerts/alerts.service";

describe("HouseholdService.getHouseholdSummary", () => {
  let service: HouseholdService;

  const mockPrisma = {
    client: {
      user: { findUnique: jest.fn() },
      household: { findUnique: jest.fn(), create: jest.fn() },
      dependent: { create: jest.fn(), deleteMany: jest.fn() },
    },
  };
  const mockIncome = { monthlyForecast: jest.fn(), list: jest.fn() };
  const mockExpenses = { list: jest.fn(), detectSubscriptions: jest.fn() };
  const mockInvestments = { totalCurrentValue: jest.fn() };
  const mockLoans = { totalOutstanding: jest.fn() };
  const mockProperty = { totalCurrentValue: jest.fn() };
  const mockGoals = { list: jest.fn() };
  const mockBusiness = { listBusinesses: jest.fn(), monthlySummary: jest.fn() };
  const mockAlerts = { list: jest.fn() };

  const owner = { id: "owner-1", name: "Alex Owner", role: "OWNER", householdId: "hh-1" };
  const member = { id: "member-1", name: "Sam Member", role: "MEMBER", householdId: "hh-1" };
  const household = { id: "hh-1", name: "The Household", members: [owner, member], dependents: [] };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.client.household.findUnique.mockResolvedValue(household);
    // Every member gets the same simple per-user financials for these tests, so sums
    // are easy to hand-verify: 50000 income, 30000 expenses, 100000 investments,
    // 200000 property, 50000 debt, one 500000-target/100000-saved goal, 2 unread alerts.
    mockIncome.monthlyForecast.mockResolvedValue(50000);
    mockIncome.list.mockResolvedValue([{ amount: 50000 }]);
    mockExpenses.list.mockResolvedValue([{ amount: 30000 }]);
    mockExpenses.detectSubscriptions.mockResolvedValue([]);
    mockInvestments.totalCurrentValue.mockResolvedValue(100000);
    mockProperty.totalCurrentValue.mockResolvedValue(200000);
    mockLoans.totalOutstanding.mockResolvedValue(50000);
    mockGoals.list.mockResolvedValue([{ targetAmount: "500000", currentAmount: "100000", linkedInvestmentValue: "0" }]);
    mockBusiness.listBusinesses.mockResolvedValue([]);
    mockAlerts.list.mockResolvedValue([{ id: "a1" }, { id: "a2" }]);

    const moduleRef = await Test.createTestingModule({
      providers: [
        HouseholdService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: mockIncome },
        { provide: ExpensesService, useValue: mockExpenses },
        { provide: InvestmentsService, useValue: mockInvestments },
        { provide: LoansService, useValue: mockLoans },
        { provide: PropertyService, useValue: mockProperty },
        { provide: GoalsService, useValue: mockGoals },
        { provide: BusinessService, useValue: mockBusiness },
        { provide: AlertsService, useValue: mockAlerts },
      ],
    }).compile();
    service = moduleRef.get(HouseholdService);
  });

  describe("permission boundary", () => {
    it("returns per-member breakdown for an OWNER viewer", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);

      const summary = await service.getHouseholdSummary("owner-1");

      expect(summary.viewerRole).toBe("OWNER");
      expect(summary.members).not.toBeNull();
      expect(summary.members).toHaveLength(2);
      expect(summary.members?.map((m) => m.userId).sort()).toEqual(["member-1", "owner-1"]);
    });

    it("returns null member breakdown (rollups only) for a MEMBER viewer, even though the aggregate totals are identical", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(member);

      const summary = await service.getHouseholdSummary("member-1");

      expect(summary.viewerRole).toBe("MEMBER");
      expect(summary.members).toBeNull();
      // Aggregate totals are still fully computed for a MEMBER viewer — only the
      // per-person breakdown is withheld.
      expect(summary.totalNetWorth).not.toBe("0.00");
    });

    it("never leaks another member's data into a MEMBER viewer's response shape", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(member);
      const summary = await service.getHouseholdSummary("member-1");
      const serialized = JSON.stringify(summary);
      expect(serialized).not.toContain("Alex Owner"); // the other member's name never appears
    });
  });

  describe("multi-member aggregation correctness", () => {
    it("sums each member's own net worth exactly once into the household total (no double counting)", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);

      const summary = await service.getHouseholdSummary("owner-1");

      // Each member: cash(50000-30000=20000) + investments(100000) + property(200000) - debt(50000) = 270000
      // Two members => 540000 total, not 270000 (would indicate one member being dropped)
      // and not more than 540000 (would indicate someone counted twice).
      expect(summary.totalNetWorth).toBe("540000.00");
      expect(summary.totalMonthlyIncome).toBe("100000.00"); // 50000 x 2
      expect(summary.totalDebt).toBe("100000.00"); // 50000 x 2
      expect(summary.totalUnreadAlerts).toBe(4); // 2 alerts x 2 members
    });

    it("gathers each member's financials via their own userId exactly once", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);

      await service.getHouseholdSummary("owner-1");

      const calledUserIds = mockIncome.monthlyForecast.mock.calls.map((c) => c[0]);
      expect(calledUserIds.sort()).toEqual(["member-1", "owner-1"]);
      expect(mockIncome.monthlyForecast).toHaveBeenCalledTimes(2); // once per member, not more
    });
  });

  describe("shared subscription flagging", () => {
    it("flags a merchant recurring for 2+ members instead of silently summing it as separate charges", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockExpenses.detectSubscriptions
        .mockResolvedValueOnce([{ merchant: "Netflix", occurrences: 3, averageAmount: 649 }]) // owner
        .mockResolvedValueOnce([{ merchant: "netflix", occurrences: 2, averageAmount: 649 }]); // member (case-insensitive match)

      const summary = await service.getHouseholdSummary("owner-1");

      expect(summary.possibleSharedSubscriptions).toHaveLength(1);
      expect(summary.possibleSharedSubscriptions[0].merchant).toBe("netflix");
      expect(summary.possibleSharedSubscriptions[0].memberNames).toHaveLength(2);
    });

    it("does not flag a subscription only one member has", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockExpenses.detectSubscriptions
        .mockResolvedValueOnce([{ merchant: "Spotify", occurrences: 3, averageAmount: 119 }])
        .mockResolvedValueOnce([]);

      const summary = await service.getHouseholdSummary("owner-1");

      expect(summary.possibleSharedSubscriptions).toHaveLength(0);
    });

    it("redacts member names from the shared-subscription flag for a MEMBER viewer (still flags it, but doesn't say who)", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(member);
      mockExpenses.detectSubscriptions
        .mockResolvedValueOnce([{ merchant: "Netflix", occurrences: 3, averageAmount: 649 }])
        .mockResolvedValueOnce([{ merchant: "netflix", occurrences: 2, averageAmount: 649 }]);

      const summary = await service.getHouseholdSummary("member-1");

      expect(summary.possibleSharedSubscriptions).toHaveLength(1);
      expect(summary.possibleSharedSubscriptions[0].memberNames).toEqual([]);
    });
  });
});

describe("HouseholdService dependent-management helpers", () => {
  let service: HouseholdService;
  const mockPrisma = {
    client: {
      user: { findUnique: jest.fn() },
      household: { findUnique: jest.fn(), create: jest.fn() },
      dependent: { create: jest.fn(), deleteMany: jest.fn() },
    },
  };
  const noop = {};

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HouseholdService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: noop },
        { provide: ExpensesService, useValue: noop },
        { provide: InvestmentsService, useValue: noop },
        { provide: LoansService, useValue: noop },
        { provide: PropertyService, useValue: noop },
        { provide: GoalsService, useValue: noop },
        { provide: BusinessService, useValue: noop },
        { provide: AlertsService, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(HouseholdService);
  });

  it("getOrCreateHouseholdForUser reuses an existing household rather than creating a duplicate", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "hh-1", name: "Aarav" });
    mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [], dependents: [] });

    await service.getOrCreateHouseholdForUser("user-1");

    expect(mockPrisma.client.household.create).not.toHaveBeenCalled();
  });

  it("getOrCreateHouseholdForUser creates a new household when the user doesn't have one yet", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: null, name: "Aarav" });
    mockPrisma.client.household.create.mockResolvedValue({ id: "hh-new", members: [], dependents: [] });

    await service.getOrCreateHouseholdForUser("user-1");

    expect(mockPrisma.client.household.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ members: { connect: { id: "user-1" } } }) }),
    );
  });

  it("addDependent scopes the new dependent to the user's own household", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "hh-1", name: "Aarav" });
    mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [], dependents: [] });
    mockPrisma.client.dependent.create.mockResolvedValue({ id: "dep-1", householdId: "hh-1", name: "Meera", relation: "Spouse" });

    await service.addDependent("user-1", { name: "Meera", relation: "Spouse" });

    expect(mockPrisma.client.dependent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ householdId: "hh-1", name: "Meera" }) }),
    );
  });

  it("removeDependent scopes the delete to the user's own household (can't delete another household's dependent)", async () => {
    mockPrisma.client.user.findUnique.mockResolvedValue({ id: "user-1", householdId: "hh-1", name: "Aarav" });
    mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [], dependents: [] });

    await service.removeDependent("user-1", "dep-1");

    expect(mockPrisma.client.dependent.deleteMany).toHaveBeenCalledWith({
      where: { id: "dep-1", householdId: "hh-1" },
    });
  });
});

describe("HouseholdService invite / accept / decline / revoke / leave (new)", () => {
  let service: HouseholdService;
  const mockPrisma = {
    client: {
      user: { findUnique: jest.fn(), update: jest.fn() },
      household: { findUnique: jest.fn(), create: jest.fn() },
      dependent: { create: jest.fn(), deleteMany: jest.fn() },
      householdInvite: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
    },
  };
  const noop = {};

  const owner = { id: "owner-1", email: "owner@example.com", name: "Alex Owner", role: "OWNER", householdId: "hh-1" };
  const member = { id: "member-1", email: "member@example.com", name: "Sam Member", role: "MEMBER", householdId: "hh-1" };
  const newUser = { id: "new-1", email: "new@example.com", name: "New Person", role: "OWNER", householdId: "hh-solo" };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        HouseholdService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: IncomeService, useValue: noop },
        { provide: ExpensesService, useValue: noop },
        { provide: InvestmentsService, useValue: noop },
        { provide: LoansService, useValue: noop },
        { provide: PropertyService, useValue: noop },
        { provide: GoalsService, useValue: noop },
        { provide: BusinessService, useValue: noop },
        { provide: AlertsService, useValue: noop },
      ],
    }).compile();
    service = moduleRef.get(HouseholdService);
  });

  describe("createInvite", () => {
    it("lets an OWNER create an invite and returns the raw token exactly once", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner], dependents: [] });
      mockPrisma.client.householdInvite.findFirst.mockResolvedValue(null); // no existing pending invite
      mockPrisma.client.householdInvite.create.mockResolvedValue({ id: "inv-1", email: "friend@example.com" });

      const result = await service.createInvite("owner-1", { email: "friend@example.com" });

      expect(result.token).toBeDefined();
      expect(typeof result.token).toBe("string");
      expect(result.invite.id).toBe("inv-1");
      // The raw token is never part of what's persisted — only its hash.
      const createCall = mockPrisma.client.householdInvite.create.mock.calls[0][0];
      expect(createCall.data).not.toHaveProperty("token");
      expect(createCall.data.tokenHash).toBeDefined();
      expect(createCall.data.tokenHash).not.toBe(result.token);
    });

    it("rejects invite creation from a MEMBER (not the household owner)", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(member);

      await expect(service.createInvite("member-1", { email: "x@example.com" })).rejects.toThrow(
        ForbiddenException,
      );
      expect(mockPrisma.client.householdInvite.create).not.toHaveBeenCalled();
    });

    it("rejects creating a second pending invite for the same email", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner], dependents: [] });
      mockPrisma.client.householdInvite.findFirst.mockResolvedValue({ id: "existing-inv", status: "PENDING" });

      await expect(service.createInvite("owner-1", { email: "friend@example.com" })).rejects.toThrow(
        BadRequestException,
      );
      expect(mockPrisma.client.householdInvite.create).not.toHaveBeenCalled();
    });
  });

  describe("listInvites / revokeInvite", () => {
    it("lets an OWNER list invites for their household", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner], dependents: [] });
      mockPrisma.client.householdInvite.findMany.mockResolvedValue([{ id: "inv-1" }]);

      const invites = await service.listInvites("owner-1");

      expect(invites).toHaveLength(1);
      expect(mockPrisma.client.householdInvite.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { householdId: "hh-1" } }),
      );
    });

    it("rejects a MEMBER trying to list invites", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(member);
      await expect(service.listInvites("member-1")).rejects.toThrow(ForbiddenException);
    });

    it("revokes a pending invite scoped to the owner's own household", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner], dependents: [] });
      mockPrisma.client.householdInvite.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.revokeInvite("owner-1", "inv-1");

      expect(mockPrisma.client.householdInvite.updateMany).toHaveBeenCalledWith({
        where: { id: "inv-1", householdId: "hh-1", status: "PENDING" },
        data: { status: "REVOKED", respondedAt: expect.any(Date) },
      });
      expect(result).toEqual({ id: "inv-1" });
    });

    it("throws NotFoundException revoking an invite that isn't pending or doesn't belong to this household", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner], dependents: [] });
      mockPrisma.client.householdInvite.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.revokeInvite("owner-1", "not-mine")).rejects.toThrow(NotFoundException);
    });
  });

  describe("acceptInvite", () => {
    it("adds a solo user to the inviting household and marks the invite ACCEPTED", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(newUser); // accepter, solo household
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "new@example.com",
        status: "PENDING", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-solo", members: [newUser] }); // solo, safe to leave
      mockPrisma.client.user.update.mockResolvedValue({});
      mockPrisma.client.householdInvite.update.mockResolvedValue({});

      await service.acceptInvite("new-1", { token: "any-raw-token" });

      expect(mockPrisma.client.user.update).toHaveBeenCalledWith({
        where: { id: "new-1" },
        data: { householdId: "hh-1", role: "MEMBER" },
      });
      expect(mockPrisma.client.householdInvite.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: "ACCEPTED", respondedAt: expect.any(Date) },
      });
    });

    it("rejects a token that doesn't match the accepting user's own email (no oracle for whose invite it is)", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(newUser); // new@example.com
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "someone-else@example.com", // different email
        status: "PENDING", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      await expect(service.acceptInvite("new-1", { token: "any-raw-token" })).rejects.toThrow(NotFoundException);
    });

    it("rejects and auto-expires an invite past its expiresAt", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(newUser);
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "new@example.com",
        status: "PENDING", expiresAt: new Date(Date.now() - 1000 * 60), // already expired
      });

      await expect(service.acceptInvite("new-1", { token: "any-raw-token" })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.householdInvite.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: "EXPIRED" },
      });
    });

    it("rejects an invite that's already been responded to", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(newUser);
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "new@example.com",
        status: "ACCEPTED", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });

      await expect(service.acceptInvite("new-1", { token: "any-raw-token" })).rejects.toThrow(BadRequestException);
    });

    it("blocks accepting while already part of a household with other members", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ ...newUser, householdId: "hh-existing" });
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "new@example.com",
        status: "PENDING", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });
      mockPrisma.client.household.findUnique.mockResolvedValue({
        id: "hh-existing",
        members: [{ id: "new-1" }, { id: "other-1" }], // 2 members -> not safe to silently leave
      });

      await expect(service.acceptInvite("new-1", { token: "any-raw-token" })).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.user.update).not.toHaveBeenCalled();
    });
  });

  describe("declineInvite", () => {
    it("marks a pending invite addressed to the caller as DECLINED", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(newUser);
      mockPrisma.client.householdInvite.findUnique.mockResolvedValue({
        id: "inv-1", householdId: "hh-1", email: "new@example.com",
        status: "PENDING", expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24),
      });
      mockPrisma.client.householdInvite.update.mockResolvedValue({});

      const result = await service.declineInvite("new-1", { token: "any-raw-token" });

      expect(mockPrisma.client.householdInvite.update).toHaveBeenCalledWith({
        where: { id: "inv-1" },
        data: { status: "DECLINED", respondedAt: expect.any(Date) },
      });
      expect(result).toEqual({ id: "inv-1" });
    });
  });

  describe("leaveHousehold", () => {
    it("lets a MEMBER leave and immediately receive a fresh solo household", async () => {
      mockPrisma.client.user.findUnique
        .mockResolvedValueOnce(member) // initial lookup
        .mockResolvedValueOnce({ ...member, householdId: null }); // re-fetch inside getOrCreateHouseholdForUser after leaving
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner, member] });
      mockPrisma.client.user.update.mockResolvedValue({});
      mockPrisma.client.household.create.mockResolvedValue({ id: "hh-new-solo", members: [member], dependents: [] });

      await service.leaveHousehold("member-1");

      expect(mockPrisma.client.user.update).toHaveBeenCalledWith({
        where: { id: "member-1" },
        data: { householdId: null, role: "OWNER" },
      });
      expect(mockPrisma.client.household.create).toHaveBeenCalled(); // fresh solo household created immediately
    });

    it("blocks an OWNER from leaving a household that still has other members", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue(owner);
      mockPrisma.client.household.findUnique.mockResolvedValue({ id: "hh-1", members: [owner, member] });

      await expect(service.leaveHousehold("owner-1")).rejects.toThrow(BadRequestException);
      expect(mockPrisma.client.user.update).not.toHaveBeenCalled();
    });

    it("is a harmless no-op for a user who has no household at all", async () => {
      mockPrisma.client.user.findUnique.mockResolvedValue({ id: "solo-1", householdId: null, name: "Solo" });
      mockPrisma.client.household.create.mockResolvedValue({ id: "hh-x", members: [], dependents: [] });

      await service.leaveHousehold("solo-1");

      expect(mockPrisma.client.user.update).not.toHaveBeenCalled();
    });
  });
});
