import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { UpdateProfileDto } from "./dto/update-profile.dto";
import { AuditService } from "../audit/audit.service";

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.client.user.update({
      where: { id: userId },
      data: dto,
    });
    await this.audit.log("profile_updated", userId, { fields: Object.keys(dto) });
    return user;
  }

  async exportData(userId: string) {
    const [user, incomes, expenses] = await Promise.all([
      this.prisma.client.user.findUnique({
        where: { id: userId },
        include: { household: { include: { dependents: true } } },
      }),
      this.prisma.client.income.findMany({ where: { userId } }),
      this.prisma.client.expense.findMany({ where: { userId } }),
    ]);
    await this.audit.log("data_export_requested", userId);
    return { user, incomes, expenses, exportedAt: new Date().toISOString() };
  }

  async deleteAccount(userId: string) {
    // Cascades remove sessions, incomes, expenses, otp codes (see schema onDelete rules).
    await this.prisma.client.user.delete({ where: { id: userId } });
  }
}
