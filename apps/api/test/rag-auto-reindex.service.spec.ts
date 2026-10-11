import { Test } from "@nestjs/testing";
import { RagAutoReindexService } from "../src/ai/ops/rag-auto-reindex.service";
import { AiQueueService } from "../src/ai/ops/ai-queue.service";

describe("RagAutoReindexService (new, audit item #7)", () => {
  let service: RagAutoReindexService;
  const mockQueue = { enqueue: jest.fn() };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [RagAutoReindexService, { provide: AiQueueService, useValue: mockQueue }],
    }).compile();
    service = moduleRef.get(RagAutoReindexService);
  });

  it("enqueues rag.reindex.user with an hourly idempotency key scoped to the user", async () => {
    mockQueue.enqueue.mockResolvedValue({ id: "job-1" });

    await service.triggerFor("user-1");

    expect(mockQueue.enqueue).toHaveBeenCalledWith(
      "rag.reindex.user",
      { userId: "user-1" },
      { userId: "user-1", idempotencyKey: expect.stringMatching(/^reindex:\d{4}-\d{2}-\d{2}T\d{2}$/) },
    );
  });

  it("does not throw when the underlying enqueue call fails — best-effort by design", async () => {
    mockQueue.enqueue.mockRejectedValue(new Error("queue unavailable"));

    await expect(service.triggerFor("user-1")).resolves.toBeUndefined();
  });

  it("collapses a burst of writes in the same hour into a single enqueue (in-process throttle)", async () => {
    mockQueue.enqueue.mockResolvedValue({ id: "job-1" });

    await service.triggerFor("user-1");
    await service.triggerFor("user-1");

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(1);
    expect(mockQueue.enqueue.mock.calls[0][2].idempotencyKey).toMatch(/^reindex:\d{4}-\d{2}-\d{2}T\d{2}$/);
  });

  it("still enqueues separately for a different user", async () => {
    mockQueue.enqueue.mockResolvedValue({ id: "job-1" });

    await service.triggerFor("user-1");
    await service.triggerFor("user-2");

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not mark the hour as done when the enqueue fails, so the next write retries", async () => {
    mockQueue.enqueue.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({ id: "job-2" });

    await service.triggerFor("user-1");
    await service.triggerFor("user-1");

    expect(mockQueue.enqueue).toHaveBeenCalledTimes(2);
  });
});
