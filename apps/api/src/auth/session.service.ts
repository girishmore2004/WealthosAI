import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { RedisService } from "../redis/redis.service";

@Injectable()
export class SessionService {
  constructor(
    private prisma: PrismaService,
    private redis: RedisService,
    private config: ConfigService,
  ) {}

  private get ttlSeconds() {
    return this.config.get<number>("sessionTtlSeconds")!;
  }

  async createSession(userId: string, userAgent?: string, ipAddress?: string) {
    const expiresAt = new Date(Date.now() + this.ttlSeconds * 1000);
    const session = await this.prisma.client.session.create({
      data: { userId, expiresAt, userAgent, ipAddress },
    });
    await this.redis.set(`session:${session.id}`, userId, this.ttlSeconds);
    return session;
  }

  async revokeSession(sessionId: string) {
    await this.prisma.client.session.update({
      where: { id: sessionId },
      data: { revoked: true },
    });
    await this.redis.del(`session:${sessionId}`);
  }

  async revokeAllSessionsForUser(userId: string) {
    const sessions = await this.prisma.client.session.findMany({
      where: { userId, revoked: false },
    });
    await this.prisma.client.session.updateMany({
      where: { userId },
      data: { revoked: true },
    });
    await Promise.all(sessions.map((s) => this.redis.del(`session:${s.id}`)));
  }

  async listDeviceHistory(userId: string) {
    return this.prisma.client.session.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
  }
}
