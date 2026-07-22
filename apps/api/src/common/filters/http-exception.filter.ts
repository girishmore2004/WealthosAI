import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from "@nestjs/common";
import { Response } from "express";
import { MulterError } from "multer";

// Normalizes every error into a consistent { statusCode, message, error } shape
// so the web app never has to guess the error format.
@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // multer enforces its own upload limits (e.g. fileSize) during the multipart parse,
    // before the request ever reaches DocumentsService's own validation — without this,
    // an oversized upload would otherwise fall through to a generic 500.
    if (exception instanceof MulterError) {
      const message =
        exception.code === "LIMIT_FILE_SIZE" ? "File exceeds the maximum upload size" : exception.message;
      response.status(HttpStatus.BAD_REQUEST).json({ statusCode: HttpStatus.BAD_REQUEST, message, error: "BadRequest" });
      return;
    }

    const isHttpException = exception instanceof HttpException;
    const statusCode = isHttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = isHttpException ? exception.getResponse() : null;

    const message =
      typeof body === "object" && body !== null && "message" in body
        ? (body as { message: string | string[] }).message
        : exception instanceof Error
          ? exception.message
          : "Internal server error";

    if (!isHttpException) {
      // eslint-disable-next-line no-console
      console.error("Unhandled exception:", exception);
    }

    response.status(statusCode).json({
      statusCode,
      message,
      error: isHttpException ? exception.name : "InternalServerError",
    });
  }
}
