import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { Request } from "express";
import { PrismaService } from "../../prisma/prisma.service";
import { SessionService } from "../../auth/session.service";

export const SESSION_COOKIE_NAME = "wos_session";

// Server-side session lookup: cookie holds only an opaque, cryptographically random
// bearer token — never a database id, never user data. All token->session resolution
// (Redis fast path, Postgres fallback, legacy-id migration shim) is centralized in
// SessionService.resolveToken() rather than duplicated here, so there is exactly one
// place that defines what makes a session valid.
//
// DI NOTE: this guard now depends on SessionService (previously RedisService directly).
// SessionService is exported from AuthModule. Whichever module registers this guard (or
// whichever modules use `@UseGuards(SessionAuthGuard)`) must be able to resolve
// SessionService from the Nest DI graph — the same way PrismaService already needs to be
// globally resolvable today for this guard to work at all. If PrismaModule/CommonModule
// is `@Global()`, AuthModule likely needs the same treatment (or an explicit import
// wherever this guard is used). Verify against app.module.ts / common.module.ts before
// deploying this change — request that file path if it isn't already available.
@Injectable()
export class SessionAuthGuard implements CanActivate {
  constructor(
    private sessions: SessionService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const rawToken = request.cookies?.[SESSION_COOKIE_NAME];

    if (!rawToken) {
      throw new UnauthorizedException("Not authenticated");
    }

    const resolved = await this.sessions.resolveToken(rawToken);
    if (!resolved) {
      throw new UnauthorizedException("Session expired");
    }

    const user = await this.prisma.client.user.findUnique({ where: { id: resolved.userId } });
    if (!user) {
      throw new UnauthorizedException("User not found");
    }

    (request as Request & { user: typeof user; sessionId: string }).user = user;
    (request as Request & { user: typeof user; sessionId: string }).sessionId = resolved.sessionId;
    return true;
  }
}
