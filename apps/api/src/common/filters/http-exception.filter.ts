// apps/api/src/common/filters/http-exception.filter.ts
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { MulterError } from "multer";

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse();

    if (exception instanceof MulterError) {
      const message =
        exception.code === "LIMIT_FILE_SIZE" ? "Uploaded file exceeds the maximum allowed size." : exception.message;
      return res.status(HttpStatus.BAD_REQUEST).json({ statusCode: HttpStatus.BAD_REQUEST, message });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const message =
        typeof body === "string" ? body : ((body as { message?: unknown }).message ?? exception.message);
      return res.status(status).json({ statusCode: status, message });
    }

    // Log the error name only; never echo its message (it can contain Prisma args or PII).
    // For database errors also log the Prisma error CODE (e.g. P2021 = table missing, P2022 = column
    // missing, P2024 = connection pool timeout). The code and the table/column names in `meta` carry
    // no user data, so this makes a 500 diagnosable from the host's logs without leaking anything.
    const code = (exception as { code?: unknown } | null)?.code;
    const meta = (exception as { meta?: { table?: unknown; column?: unknown; modelName?: unknown } } | null)?.meta;
    const detail =
      typeof code === "string" && /^P\d{4}$/.test(code)
        ? ` code=${code}${meta && typeof meta.table === "string" ? ` table=${meta.table}` : ""}${meta && typeof meta.column === "string" ? ` column=${meta.column}` : ""}${meta && typeof meta.modelName === "string" ? ` model=${meta.modelName}` : ""}`
        : "";
    console.error(`Unhandled error: ${exception instanceof Error ? exception.name : "UnknownError"}${detail}`);
    return res
      .status(HttpStatus.INTERNAL_SERVER_ERROR)
      .json({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR, message: "Internal server error" });
  }
}
