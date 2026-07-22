import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { Prisma } from "@wealthos/db";

@Injectable()
export class AuditService {
  constructor(private prisma: PrismaService) {}

  async log(action: string, userId?: string, metadata?: Prisma.InputJsonValue) {
    await this.prisma.client.auditLog.create({
      data: { action, userId, metadata },
    });
  }

  async listForUser(userId: string, take = 50) {
    return this.prisma.client.auditLog.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }
}
