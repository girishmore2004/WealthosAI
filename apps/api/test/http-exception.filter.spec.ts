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
