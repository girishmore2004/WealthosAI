import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { SessionService } from "./session.service";
import { RequestOtpDto } from "./dto/request-otp.dto";
import { VerifyOtpDto } from "./dto/verify-otp.dto";
import { SessionAuthGuard, SESSION_COOKIE_NAME } from "../common/guards/session-auth.guard";
import { CurrentUser } from "../common/decorators/current-user.decorator";
import { getSessionCookieOptions } from "./session-cookie.util";
import { User } from "@wealthos/db";

@Controller("auth")
export class AuthController {
  constructor(
    private authService: AuthService,
    private sessionService: SessionService,
    private config: ConfigService,
  ) {}

  @Post("otp/request")
  @HttpCode(200)
  requestOtp(@Body() dto: RequestOtpDto, @Req() req: Request) {
    // req.ip feeds the new per-IP hourly cap in AuthService.requestOtp — see that file
    // for why the per-identifier cap alone isn't sufficient (it does nothing to stop one
    // attacker IP spraying requests across many different target emails).
    return this.authService.requestOtp(dto.email, req.ip);
  }

  @Post("otp/verify")
  @HttpCode(200)
  async verifyOtp(@Body() dto: VerifyOtpDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const { user, session, rawToken } = await this.authService.verifyOtp(
      dto.email,
      dto.code,
      req.headers["user-agent"] as string | undefined,
      req.ip,
    );

    // Cookie value is now the opaque bearer token (rawToken), never the DB session id —
    // see session.service.ts. `session` is still returned by the service for its
    // metadata (expiresAt, etc.) but `session.id` must never be written to the cookie.
    res.cookie(
      SESSION_COOKIE_NAME,
      rawToken,
      getSessionCookieOptions(this.config, this.config.get<number>("sessionTtlSeconds")! * 1000),
    );

    return { user: { id: user.id, email: user.email, name: user.name } };
  }

  @UseGuards(SessionAuthGuard)
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: Request & { sessionId: string; user: User }, @Res({ passthrough: true }) res: Response) {
    await this.authService.logout(req.sessionId, req.user.id);
    res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(this.config));
    return { message: "Logged out" };
  }

  @UseGuards(SessionAuthGuard)
  @Post("logout-all")
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: User, @Res({ passthrough: true }) res: Response) {
    await this.authService.logoutAllDevices(user.id);
    res.clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(this.config));
    return { message: "Logged out of all devices" };
  }

  @UseGuards(SessionAuthGuard)
  @Get("me")
  me(@CurrentUser() user: User) {
    return { user };
  }

  @UseGuards(SessionAuthGuard)
  @Get("devices")
  devices(@CurrentUser() user: User) {
    return this.sessionService.listDeviceHistory(user.id);
  }
}
