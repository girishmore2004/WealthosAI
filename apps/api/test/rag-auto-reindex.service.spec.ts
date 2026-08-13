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

  it("uses the same idempotency-key format for two calls within the same hour, so a burst of writes collapses into one job", async () => {
    mockQueue.enqueue.mockResolvedValue({ id: "job-1" });

    await service.triggerFor("user-1");
    await service.triggerFor("user-1");

    const [firstCallKey] = mockQueue.enqueue.mock.calls[0][2] ? [mockQueue.enqueue.mock.calls[0][2].idempotencyKey] : [undefined];
    const [secondCallKey] = mockQueue.enqueue.mock.calls[1][2] ? [mockQueue.enqueue.mock.calls[1][2].idempotencyKey] : [undefined];
    expect(firstCallKey).toBe(secondCallKey);
  });
});
