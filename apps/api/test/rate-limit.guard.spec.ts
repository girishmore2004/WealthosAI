import { ExecutionContext, HttpException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimitGuard } from "../src/common/guards/rate-limit.guard";
import { RATE_LIMIT_KEY } from "../src/common/decorators/rate-limit.decorator";

function makeContext(user?: { id: string }): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, ip: "127.0.0.1" }),
    }),
    getClass: () => ({ name: "TestController" }) as any,
    getHandler: () => ({ name: "testRoute" }) as any,
  } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  let guard: RateLimitGuard;
  const mockReflector = { get: jest.fn() };
  const mockRedis = { incrWithExpiry: jest.fn() };

  beforeEach(() => {
    jest.clearAllMocks();
    guard = new RateLimitGuard(mockReflector as unknown as Reflector, mockRedis as any);
  });

  it("allows the request through when the route has no @RateLimit() metadata", async () => {
    mockReflector.get.mockReturnValue(undefined);

    const allowed = await guard.canActivate(makeContext({ id: "user-1" }));

    expect(allowed).toBe(true);
    expect(mockRedis.incrWithExpiry).not.toHaveBeenCalled();
    expect(mockReflector.get).toHaveBeenCalledWith(RATE_LIMIT_KEY, expect.anything());
  });

  it("allows the request through while the count is at or below the limit", async () => {
    mockReflector.get.mockReturnValue({ limit: 5, windowSeconds: 60 });
    mockRedis.incrWithExpiry.mockResolvedValue(5);

    const allowed = await guard.canActivate(makeContext({ id: "user-1" }));

    expect(allowed).toBe(true);
  });

  it("throws 429 once the count exceeds the limit", async () => {
    mockReflector.get.mockReturnValue({ limit: 5, windowSeconds: 60 });
    mockRedis.incrWithExpiry.mockResolvedValue(6);

    await expect(guard.canActivate(makeContext({ id: "user-1" }))).rejects.toThrow(HttpException);
  });

  it("keys the rate limit counter by user id, route class, and handler name", async () => {
    mockReflector.get.mockReturnValue({ limit: 5, windowSeconds: 60 });
    mockRedis.incrWithExpiry.mockResolvedValue(1);

    await guard.canActivate(makeContext({ id: "user-42" }));

    expect(mockRedis.incrWithExpiry).toHaveBeenCalledWith(
      "ratelimit:TestController.testRoute:user-42",
      60,
    );
  });

  it("falls back to request IP when there is no authenticated user on the request", async () => {
    mockReflector.get.mockReturnValue({ limit: 5, windowSeconds: 60 });
    mockRedis.incrWithExpiry.mockResolvedValue(1);

    await guard.canActivate(makeContext(undefined));

    expect(mockRedis.incrWithExpiry).toHaveBeenCalledWith(
      "ratelimit:TestController.testRoute:127.0.0.1",
      60,
    );
  });
});
