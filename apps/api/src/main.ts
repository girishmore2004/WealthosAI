import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";
import { securityHeaders } from "./common/security/security-headers.middleware";
import { buildOriginMatcher, csrfOriginCheck } from "./common/security/origin-check";
import { SESSION_COOKIE_NAME } from "./common/guards/session-auth.guard";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const allowedOrigins = [config.get<string>("webUrl")!, ...config.get<string[]>("corsExtraOrigins")!];
  const previewPrefix = config.get<string>("vercelPreviewPrefix");

  const isTrustedOrigin = buildOriginMatcher({ allowedOrigins, vercelPreviewPrefix: previewPrefix });

  // Don't advertise the framework, and send hardening headers on every response.
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.use(securityHeaders(process.env.NODE_ENV === "production"));
  app.use(cookieParser());
  // CSRF: cookie-authenticated, state-changing requests must come from a trusted origin.
  // Runs after cookieParser (it reads the session cookie) and before any controller.
  app.use(csrfOriginCheck(isTrustedOrigin, SESSION_COOKIE_NAME));
  app.enableCors({
    origin(origin, callback) {
      // No Origin header — same-origin requests, curl, server-to-server health checks, etc.
      if (!origin) return callback(null, true);
      // Vercel preview deployments get a random per-branch suffix, so an exact match against
      // WEB_URL can never cover them; opt-in via VERCEL_PREVIEW_PREFIX (see buildOriginMatcher).
      if (isTrustedOrigin(origin)) return callback(null, true);
      return callback(new Error(`Origin ${origin} not allowed by CORS`), false);
    },
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // Render/Railway/Heroku-style hosts inject PORT and route traffic to it — check that
  // first, falling back to API_PORT for local/self-hosted setups where PORT isn't set.
  const port = process.env.PORT ?? process.env.API_PORT ?? 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`WealthOS AI API listening on http://localhost:${port}`);
}

bootstrap();
