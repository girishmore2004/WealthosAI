import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateSettingsDto } from "./dto/update-settings.dto";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async getOrCreate(userId: string) {
    const existing = await this.prisma.client.userSettings.findUnique({ where: { userId } });
    if (existing) return existing;
    return this.prisma.client.userSettings.create({ data: { userId } });
  }

  async update(userId: string, dto: UpdateSettingsDto) {
    await this.getOrCreate(userId);
    const settings = await this.prisma.client.userSettings.update({
      where: { userId },
      data: dto,
    });
    await this.audit.log("settings_updated", userId, { fields: Object.keys(dto) });
    return settings;
  }
}
