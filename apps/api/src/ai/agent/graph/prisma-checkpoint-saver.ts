import { RunnableConfig } from "@langchain/core/runnables";
import {
  BaseCheckpointSaver,
  ChannelVersions,
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
  WRITES_IDX_MAP,
  compareWritesSortKeys,
  copyCheckpoint,
  getCheckpointId,
  writesSortKey,
} from "@langchain/langgraph-checkpoint";
import { PrismaService } from "../../../prisma/prisma.service";

// LangGraph checkpoint store on PostgreSQL (AgentCheckpoint / AgentCheckpointWrite), so a graph run survives a restart and a
// run paused for approval can be resumed hours later from any instance.
//
// Isolation: every read and write REQUIRES `configurable.user_id` and filters on it. A thread id alone is never enough to
// load or overwrite a checkpoint, so even a leaked or guessed conversation id cannot reach another user's graph state.
const SAFE_KEY = /^[A-Za-z0-9_.:-]{1,128}$/;

function userIdOf(config: RunnableConfig): string {
  const userId = config.configurable?.user_id;
  if (typeof userId !== "string" || !SAFE_KEY.test(userId)) throw new Error("Checkpoint access requires configurable.user_id");
  return userId;
}

function assertKey(field: string, value: unknown, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value === "") || (value !== "" && !SAFE_KEY.test(value))) throw new Error(`Invalid checkpoint ${field}`);
  return value;
}

export class PrismaCheckpointSaver extends BaseCheckpointSaver {
  constructor(private prisma: PrismaService) {
    super();
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const userId = userIdOf(config);
    const threadId = assertKey("thread_id", config.configurable?.thread_id);
    const ns = assertKey("checkpoint_ns", config.configurable?.checkpoint_ns ?? "", true);
    const checkpointId = getCheckpointId(config);
    const row = checkpointId
      ? await this.prisma.client.agentCheckpoint.findFirst({ where: { threadId, checkpointNs: ns, checkpointId: assertKey("checkpoint_id", checkpointId), userId } })
      : await this.prisma.client.agentCheckpoint.findFirst({ where: { threadId, checkpointNs: ns, userId }, orderBy: { checkpointId: "desc" } });
    if (!row) return undefined;
    return this.toTuple(row, userId);
  }

  async *list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    const userId = userIdOf(config);
    const threadId = config.configurable?.thread_id !== undefined ? assertKey("thread_id", config.configurable.thread_id) : undefined;
    const ns = config.configurable?.checkpoint_ns !== undefined ? assertKey("checkpoint_ns", config.configurable.checkpoint_ns, true) : undefined;
    const beforeId = options?.before?.configurable?.checkpoint_id;
    const rows = await this.prisma.client.agentCheckpoint.findMany({
      where: {
        userId,
        ...(threadId ? { threadId } : {}),
        ...(ns !== undefined ? { checkpointNs: ns } : {}),
        ...(config.configurable?.checkpoint_id ? { checkpointId: assertKey("checkpoint_id", config.configurable.checkpoint_id) } : {}),
        ...(beforeId ? { checkpointId: { lt: assertKey("checkpoint_id", beforeId) } } : {}),
      },
      orderBy: { checkpointId: "desc" },
      take: options?.limit !== undefined ? Math.max(0, options.limit) : 200,
    });
    for (const row of rows) {
      const tuple = await this.toTuple(row, userId);
      if (options?.filter && !Object.entries(options.filter).every(([k, v]) => (tuple.metadata as Record<string, unknown> | undefined)?.[k] === v)) continue;
      yield tuple;
    }
  }

  async put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata, _newVersions?: ChannelVersions): Promise<RunnableConfig> {
    const userId = userIdOf(config);
    const threadId = assertKey("thread_id", config.configurable?.thread_id);
    const ns = assertKey("checkpoint_ns", config.configurable?.checkpoint_ns ?? "", true);
    const prepared = copyCheckpoint(checkpoint);
    const id = assertKey("checkpoint_id", checkpoint.id);
    const [[type, cp], [, md]] = await Promise.all([this.serde.dumpsTyped(prepared), this.serde.dumpsTyped(metadata)]);
    const parent = config.configurable?.checkpoint_id ? assertKey("checkpoint_id", config.configurable.checkpoint_id) : null;
    const existing = await this.prisma.client.agentCheckpoint.findFirst({ where: { threadId, checkpointNs: ns, checkpointId: id }, select: { userId: true } });
    if (existing && existing.userId !== userId) throw new Error("Checkpoint belongs to another user");
    await this.prisma.client.agentCheckpoint.upsert({
      where: { threadId_checkpointNs_checkpointId: { threadId, checkpointNs: ns, checkpointId: id } },
      create: { threadId, checkpointNs: ns, checkpointId: id, parentCheckpointId: parent, userId, type, checkpoint: Buffer.from(cp), metadata: Buffer.from(md) },
      update: { parentCheckpointId: parent, type, checkpoint: Buffer.from(cp), metadata: Buffer.from(md) },
    });
    return { configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: id, user_id: userId } };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string, taskPath?: string): Promise<void> {
    const userId = userIdOf(config);
    const threadId = assertKey("thread_id", config.configurable?.thread_id);
    const ns = assertKey("checkpoint_ns", config.configurable?.checkpoint_ns ?? "", true);
    const checkpointId = assertKey("checkpoint_id", config.configurable?.checkpoint_id);
    assertKey("task_id", taskId);
    for (let i = 0; i < writes.length; i++) {
      const [channel, value] = writes[i];
      const [type, data] = await this.serde.dumpsTyped(value);
      const idx = (WRITES_IDX_MAP as Record<string, number>)[channel] ?? i;
      const key = { threadId_checkpointNs_checkpointId_taskId_idx: { threadId, checkpointNs: ns, checkpointId, taskId, idx } };
      // Special channels (negative idx: errors, interrupts, resumes) overwrite; ordinary writes are first-write-wins.
      if (idx >= 0) {
        const exists = await this.prisma.client.agentCheckpointWrite.findUnique({ where: key, select: { userId: true } });
        if (exists) continue;
      }
      await this.prisma.client.agentCheckpointWrite.upsert({
        where: key,
        create: { threadId, checkpointNs: ns, checkpointId, taskId, idx, channel, type, value: Buffer.from(data), taskPath: taskPath ?? "", userId },
        update: { channel, type, value: Buffer.from(data), taskPath: taskPath ?? "" },
      });
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    assertKey("thread_id", threadId);
    await this.prisma.client.agentCheckpointWrite.deleteMany({ where: { threadId } });
    await this.prisma.client.agentCheckpoint.deleteMany({ where: { threadId } });
  }

  /** Deletes checkpoints older than `olderThan` (retention). Returns how many checkpoints were removed. */
  async purgeOlderThan(olderThan: Date): Promise<number> {
    const old = await this.prisma.client.agentCheckpoint.findMany({ where: { createdAt: { lt: olderThan } }, select: { threadId: true, checkpointNs: true, checkpointId: true }, take: 1000 });
    if (old.length === 0) return 0;
    for (const o of old) {
      await this.prisma.client.agentCheckpointWrite.deleteMany({ where: { threadId: o.threadId, checkpointNs: o.checkpointNs, checkpointId: o.checkpointId } });
    }
    const res = await this.prisma.client.agentCheckpoint.deleteMany({ where: { OR: old.map((o) => ({ threadId: o.threadId, checkpointNs: o.checkpointNs, checkpointId: o.checkpointId })) } });
    return res.count;
  }

  private async toTuple(
    row: { threadId: string; checkpointNs: string; checkpointId: string; parentCheckpointId: string | null; type: string | null; checkpoint: Uint8Array; metadata: Uint8Array },
    userId: string,
  ): Promise<CheckpointTuple> {
    const type = row.type ?? "json";
    const checkpoint = (await this.serde.loadsTyped(type, new Uint8Array(row.checkpoint))) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(type, new Uint8Array(row.metadata))) as CheckpointMetadata;
    const writes = await this.prisma.client.agentCheckpointWrite.findMany({ where: { threadId: row.threadId, checkpointNs: row.checkpointNs, checkpointId: row.checkpointId, userId } });
    const ordered = writes
      .map((w) => ({ w, key: writesSortKey(w.taskPath ?? "", w.taskId, w.idx) }))
      .sort((a, b) => compareWritesSortKeys(a.key, b.key));
    const pendingWrites = await Promise.all(ordered.map(async ({ w }) => [w.taskId, w.channel, await this.serde.loadsTyped(w.type ?? "json", new Uint8Array(w.value))] as [string, string, unknown]));
    const tuple: CheckpointTuple = {
      config: { configurable: { thread_id: row.threadId, checkpoint_ns: row.checkpointNs, checkpoint_id: row.checkpointId, user_id: userId } },
      checkpoint,
      metadata,
      pendingWrites: pendingWrites as CheckpointTuple["pendingWrites"],
    };
    if (row.parentCheckpointId) tuple.parentConfig = { configurable: { thread_id: row.threadId, checkpoint_ns: row.checkpointNs, checkpoint_id: row.parentCheckpointId, user_id: userId } };
    return tuple;
  }
}
