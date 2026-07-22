import { Test } from "@nestjs/testing";
import { SettingsService } from "../src/settings/settings.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { AuditService } from "../src/audit/audit.service";

describe("SettingsService", () => {
  let service: SettingsService;
  const mockPrisma = { client: { userSettings: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() } } };
  const mockAudit = { log: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        SettingsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
      ],
    }).compile();
    service = moduleRef.get(SettingsService);
  });

  it("returns existing settings without creating a duplicate row", async () => {
    mockPrisma.client.userSettings.findUnique.mockResolvedValue({ userId: "user-1", theme: "DARK" });

    const result = await service.getOrCreate("user-1");

    expect(result.theme).toBe("DARK");
    expect(mockPrisma.client.userSettings.create).not.toHaveBeenCalled();
  });

  it("auto-provisions default settings for a user who has none yet", async () => {
    mockPrisma.client.userSettings.findUnique.mockResolvedValue(null);
    mockPrisma.client.userSettings.create.mockResolvedValue({ userId: "user-1", theme: "LIGHT" });

    const result = await service.getOrCreate("user-1");

    expect(mockPrisma.client.userSettings.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: { userId: "user-1" } }),
    );
    expect(result.theme).toBe("LIGHT");
  });

  it("update() persists only the provided fields", async () => {
    mockPrisma.client.userSettings.findUnique.mockResolvedValue({ userId: "user-1", theme: "LIGHT" });
    mockPrisma.client.userSettings.update.mockResolvedValue({ userId: "user-1", theme: "DARK" });

    await service.update("user-1", { theme: "DARK" });

    expect(mockPrisma.client.userSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" }, data: { theme: "DARK" } }),
    );
    expect(mockAudit.log).toHaveBeenCalledWith("settings_updated", "user-1", { fields: ["theme"] });
  });
});
