import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { AiQueueService } from "../src/ai/ops/ai-queue.service";
import { PrismaService } from "../src/prisma/prisma.service";

const mockQueueAdd = jest.fn();
const mockQueueClose = jest.fn();

jest.mock("bullmq", () => ({
  Queue: jest.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: mockQueueClose,
    getJobCounts: jest.fn(),
  })),
}));

// ioredis's constructor with lazyConnect: true never opens a real socket, so
// constructing the real createAiQueueConnection() here is safe in a unit test — no
// network I/O happens unless something actually issues a command, and bullmq itself is
// mocked above so nothing does.
describe("AiQueueService.enqueue (idempotency)", () => {
  let service: AiQueueService;
  const mockPrisma = {
    client: {
      aiJob: {
        findUnique: jest.fn(),
        create: jest.fn(),
      },
    },
  };
  const mockConfig = { get: jest.fn().mockReturnValue("redis://localhost:6379") };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiQueueService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = moduleRef.get(AiQueueService);
  });

  it("creates a new AiJob and enqueues it when no idempotency key is given", async () => {
    mockPrisma.client.aiJob.create.mockResolvedValue({ id: "job-1", status: "QUEUED" });

    const job = await service.enqueue("ai.health.selfTest", { probe: "ping" }, { userId: "user-1" });

    expect(mockPrisma.client.aiJob.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.client.aiJob.create).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("job-1");
  });

  it("returns the existing AiJob without re-enqueueing when the idempotency key already exists", async () => {
    mockPrisma.client.aiJob.findUnique.mockResolvedValue({ id: "job-existing", status: "DONE" });

    const job = await service.enqueue(
      "ai.health.selfTest",
      { probe: "ping" },
      { userId: "user-1", idempotencyKey: "same-key" },
    );

    expect(mockPrisma.client.aiJob.findUnique).toHaveBeenCalledWith({
      where: { userId_idempotencyKey: { userId: "user-1", idempotencyKey: "same-key" } },
    });
    expect(mockPrisma.client.aiJob.create).not.toHaveBeenCalled();
    expect(mockQueueAdd).not.toHaveBeenCalled();
    expect(job.id).toBe("job-existing");
  });

  it("creates a new AiJob when the idempotency key hasn't been seen before", async () => {
    mockPrisma.client.aiJob.findUnique.mockResolvedValue(null);
    mockPrisma.client.aiJob.create.mockResolvedValue({ id: "job-2", status: "QUEUED" });

    const job = await service.enqueue(
      "ai.health.selfTest",
      { probe: "ping" },
      { userId: "user-1", idempotencyKey: "new-key" },
    );

    expect(mockPrisma.client.aiJob.create).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(job.id).toBe("job-2");
  });
});

describe("AiQueueService.getStatus (ownership scoping)", () => {
  let service: AiQueueService;
  const mockPrisma = { client: { aiJob: { findUnique: jest.fn() } } };
  const mockConfig = { get: jest.fn().mockReturnValue("redis://localhost:6379") };

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AiQueueService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: ConfigService, useValue: mockConfig },
      ],
    }).compile();
    service = moduleRef.get(AiQueueService);
  });

  it("returns the job when the requesting user owns it", async () => {
    mockPrisma.client.aiJob.findUnique.mockResolvedValue({ id: "job-1", userId: "user-1", status: "DONE" });
    const job = await service.getStatus("user-1", "job-1");
    expect(job?.id).toBe("job-1");
  });

  it("returns null (not the other user's job) when the requesting user does not own it", async () => {
    mockPrisma.client.aiJob.findUnique.mockResolvedValue({ id: "job-1", userId: "someone-else", status: "DONE" });
    const job = await service.getStatus("user-1", "job-1");
    expect(job).toBeNull();
  });

  it("returns null when the job doesn't exist at all", async () => {
    mockPrisma.client.aiJob.findUnique.mockResolvedValue(null);
    const job = await service.getStatus("user-1", "does-not-exist");
    expect(job).toBeNull();
  });
});
