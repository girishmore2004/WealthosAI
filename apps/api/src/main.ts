import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { ValidationPipe } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { AppModule } from "./app.module";
import { HttpExceptionFilter } from "./common/filters/http-exception.filter";
import { LoggingInterceptor } from "./common/interceptors/logging.interceptor";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  const allowedOrigins = [config.get<string>("webUrl")!, ...config.get<string[]>("corsExtraOrigins")!];
  const previewPrefix = config.get<string>("vercelPreviewPrefix");

  app.use(cookieParser());
  app.enableCors({
    origin(origin, callback) {
      // No Origin header — same-origin requests, curl, server-to-server health checks, etc.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Vercel preview deployments get a random per-branch/PR suffix appended to the
      // project name (e.g. wealthos-ai-git-my-feature-yourteam.vercel.app), so an exact
      // match against WEB_URL can never cover them. Opt-in only: VERCEL_PREVIEW_PREFIX
      // must be set, and the origin must be https + *.vercel.app, to avoid accidentally
      // trusting an unrelated vercel.app project.
      if (
        previewPrefix &&
        /^https:\/\/[a-z0-9-]+\.vercel\.app$/.test(origin) &&
        new URL(origin).hostname.startsWith(previewPrefix)
      ) {
        return callback(null, true);
      }
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
