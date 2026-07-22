import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { RedisService } from "../../redis/redis.service";
import { PrismaService } from "../../prisma/prisma.service";

export const SESSION_COOKIE_NAME = "wos_session";

// Server-side session lookup: cookie holds only an opaque session id, never user data.
// Session payload lives in Redis (fast path) with Postgres Session table as the source of
// truth for device history / "logout all devices" / audit.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private redis: RedisService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const sessionId = request.cookies?.[SESSION_COOKIE_NAME];

    if (!sessionId) {
      throw new UnauthorizedException("Not authenticated");
    }

    const cachedUserId = await this.redis.get(`session:${sessionId}`);
    let userId = cachedUserId;

    if (!userId) {
      const session = await this.prisma.client.session.findUnique({ where: { id: sessionId } });
      if (!session || session.revoked || session.expiresAt < new Date()) {
        throw new UnauthorizedException("Session expired");
      }
      userId = session.userId;
    }

    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    (request as Request & { user: typeof user; sessionId: string }).user = user;
    (request as Request & { user: typeof user; sessionId: string }).sessionId = sessionId;
    return true;
  }
}
