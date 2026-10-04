import { ArgumentsHost, HttpException, HttpStatus } from "@nestjs/common";
import { MulterError } from "multer";
import { HttpExceptionFilter } from "../src/common/filters/http-exception.filter";

function mockHost() {
  const json = jest.fn();
  const status = jest.fn().mockReturnValue({ json });
  const host = {
    switchToHttp: () => ({ getResponse: () => ({ status }) }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe("HttpExceptionFilter", () => {
  let filter: HttpExceptionFilter;

  beforeEach(() => {
    filter = new HttpExceptionFilter();
  });

  it("maps a MulterError LIMIT_FILE_SIZE to a 400 with a clear message, not a 500", () => {
    const { host, status, json } = mockHost();
    const error = new MulterError("LIMIT_FILE_SIZE");

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(
      expect.objectContaining({ statusCode: HttpStatus.BAD_REQUEST, message: expect.stringMatching(/exceeds/i) }),
    );
  });

  it("maps other MulterErrors to 400 using multer's own message", () => {
    const { host, status, json } = mockHost();
    const error = new MulterError("LIMIT_UNEXPECTED_FILE");

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: HttpStatus.BAD_REQUEST }));
  });

  it("still maps a normal HttpException to its own status code", () => {
    const { host, status, json } = mockHost();
    const error = new HttpException("Not found", HttpStatus.NOT_FOUND);

    filter.catch(error, host);

    expect(status).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ message: "Not found" }));
  });

  it("falls back to 500 for an unrecognized error", () => {
    const { host, status, json } = mockHost();

    filter.catch(new Error("boom"), host);

    expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ statusCode: HttpStatus.INTERNAL_SERVER_ERROR }));
  });
});

describe("HttpExceptionFilter — no internal detail leaks to the client", () => {
  it("returns a generic message for an unexpected error, never its own message", () => {
    const { host, json } = mockHost();
    const spy = jest.spyOn(console, "error").mockImplementation(() => undefined);

    new HttpExceptionFilter().catch(new Error('Invalid `prisma.expense.create()` invocation: amount "15000" email "a@b.com"'), host);

    const body = json.mock.calls[0][0];
    expect(body.message).toBe("Internal server error");
    expect(JSON.stringify(body)).not.toMatch(/prisma|15000|a@b\.com/);
    // The server log keeps the error NAME only, not the message/args.
    expect(spy.mock.calls[0].join(" ")).not.toMatch(/15000|a@b\.com/);
    spy.mockRestore();
  });
});
