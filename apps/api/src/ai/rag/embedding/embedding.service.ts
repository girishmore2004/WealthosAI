import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

export const EMBEDDING_DIMENSIONS = 384;

// Bump this whenever the embedding model, pooling strategy, or normalization changes
// in a way that makes previously-stored vectors no longer comparable via cosine
// similarity to freshly-computed ones (e.g. swapping Xenova/all-MiniLM-L6-v2 for a
// different model, or changing pooling from "mean" to something else). Every
// AiEmbeddingChunk row stores the EMBEDDING_MODEL_VERSION that produced it;
// RagIndexingService compares that stored value against the ACTIVE version on each reindex
// and, on a mismatch, forces a full re-embed for that user instead of silently mixing
// vectors from two incompatible embedding spaces in the same similarity search.
export const EMBEDDING_MODEL_VERSION = 1;

// Version stamped on vectors produced by the built-in hashed lexical fallback (see
// hashEmbedding()). Different from EMBEDDING_MODEL_VERSION on purpose: the two vector spaces are not
// comparable, so retrieval only ever compares a query vector with chunk vectors of the same version,
// and the next reindex after the neural model becomes available re-embeds everything.
export const HASH_EMBEDDING_MODEL_VERSION = 101;

// How long to wait before trying to load the neural model again after a failed load. Short enough
// that a transient network error on a cold start heals itself, long enough that a platform which can
// never load the model (no outbound access to huggingface.co, not enough memory) is not retried on
// every request.
const MODEL_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
// A load that takes longer than this is abandoned for the current request (the fallback answers it)
// but keeps running in the background, so the next request can use the model once it has loaded.
const MODEL_LOAD_WAIT_MS = 20 * 1000;
const QUERY_CACHE_SIZE = 200;

// Runs entirely in-process (WASM), no Groq/external inference call. Model:
// Xenova/all-MiniLM-L6-v2, a widely used 384-dim sentence-embedding model, ~90MB.
//
// The @xenova/transformers library downloads the model weights from huggingface.co on first use and
// caches them to disk (override via TRANSFORMERS_CACHE). On a small free-tier host that download or
// the ~300MB of memory the model needs can fail. Before, any such failure made EVERY search throw.
// Now the service degrades to a deterministic hashed bag-of-words embedding (lexical, no network, no
// model, ~0ms) so search keeps working with keyword-grade quality, and upgrades itself automatically
// once the neural model is available. Set EMBEDDING_PROVIDER=hash to skip the neural model entirely
// (recommended on hosts with under 1GB of RAM).
@Injectable()
export class EmbeddingService implements OnModuleInit {
  private readonly logger = new Logger(EmbeddingService.name);
  private pipelinePromise: Promise<EmbeddingPipeline> | null = null;
  private pipeline: EmbeddingPipeline | null = null;
  private nextModelAttemptAt = 0;
  private activeVersion: number = EMBEDDING_MODEL_VERSION;
  private readonly queryCache = new Map<string, EmbeddingWithVersion>();

  /** Starts loading the neural model in the background at boot, so the first search after a restart does not
   * wait ~13s for it (observed in production logs). Not awaited: boot is never delayed, and a failed load
   * already degrades to the lexical fallback. Skipped under test and when the hashed provider is forced. */
  onModuleInit(): void {
    if (process.env.NODE_ENV === "test" || this.neuralDisabled()) return;
    void this.startLoad().catch(() => undefined);
  }

  /** Version of the vectors the service is currently producing. Retrieval compares it with each
   * chunk's stored version so two incompatible vector spaces are never compared. */
  get modelVersion(): number {
    return this.activeVersion;
  }

  /** True while the hashed fallback (not the neural model) is producing vectors. */
  get isDegraded(): boolean {
    return this.activeVersion === HASH_EMBEDDING_MODEL_VERSION;
  }

  private neuralDisabled(): boolean {
    return (process.env.EMBEDDING_PROVIDER ?? "").toLowerCase() === "hash";
  }

  private startLoad(): Promise<EmbeddingPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = import("@xenova/transformers")
        .then(({ pipeline }) => pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2") as unknown as Promise<EmbeddingPipeline>)
        .then((p) => {
          this.pipeline = p;
          return p;
        });
      this.pipelinePromise.catch((err) => {
        this.logger.error(`Failed to load embedding model, using the lexical fallback: ${(err as Error).message}`);
        this.pipelinePromise = null;
        this.pipeline = null;
        this.nextModelAttemptAt = Date.now() + MODEL_RETRY_COOLDOWN_MS;
      });
    }
    return this.pipelinePromise;
  }

  /** Returns the neural pipeline when it is ready (or becomes ready within MODEL_LOAD_WAIT_MS),
   * otherwise null so the caller uses the hashed fallback. Never throws. */
  private async resolvePipeline(): Promise<EmbeddingPipeline | null> {
    if (this.neuralDisabled()) return null;
    if (this.pipeline) return this.pipeline;
    if (!this.pipelinePromise && Date.now() < this.nextModelAttemptAt) return null;

    const loading = this.startLoad();
    try {
      return await Promise.race([
        loading,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), MODEL_LOAD_WAIT_MS).unref?.()),
      ]);
    } catch {
      return null;
    }
  }

  /** Resolves which embedding space is active right now. Indexing calls this before it embeds so the
   * vectors it stores are stamped with the correct version. */
  async resolveModelVersion(): Promise<number> {
    const pipeline = await this.resolvePipeline();
    this.activeVersion = pipeline ? EMBEDDING_MODEL_VERSION : HASH_EMBEDDING_MODEL_VERSION;
    return this.activeVersion;
  }

  async embed(text: string): Promise<number[]> {
    return (await this.embedWithVersion(text)).vector;
  }

  /** Query embedding with a small LRU cache: the same question (or one of its rewrites) is embedded
   * once per process instead of on every request, which removes the model call from repeat searches. */
  async embedWithVersion(text: string): Promise<EmbeddingWithVersion> {
    const key = `${this.neuralDisabled() ? "h" : "n"}:${text}`;
    const cached = this.queryCache.get(key);
    if (cached && cached.version === (await this.resolveModelVersion())) {
      this.queryCache.delete(key);
      this.queryCache.set(key, cached);
      return cached;
    }
    const [result] = await this.embedBatchWithVersion([text]);
    this.queryCache.set(key, result);
    if (this.queryCache.size > QUERY_CACHE_SIZE) {
      const oldest = this.queryCache.keys().next().value;
      if (oldest !== undefined) this.queryCache.delete(oldest);
    }
    return result;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return (await this.embedBatchWithVersion(texts)).map((r) => r.vector);
  }

  async embedBatchWithVersion(texts: string[]): Promise<EmbeddingWithVersion[]> {
    if (texts.length === 0) return [];
    const extractor = await this.resolvePipeline();

    if (extractor) {
      try {
        const results: EmbeddingWithVersion[] = [];
        // Sequential rather than Promise.all — the WASM backend is single-threaded per pipeline
        // instance, running these concurrently wouldn't parallelize the compute.
        for (const text of texts) {
          const output = await extractor(clip(text), { pooling: "mean", normalize: true });
          results.push({ vector: Array.from(output.data as Float32Array), version: EMBEDDING_MODEL_VERSION });
        }
        this.activeVersion = EMBEDDING_MODEL_VERSION;
        return results;
      } catch (err) {
        // An inference error (out of memory, corrupt cache) must not fail the whole search/index: fall
        // back, and let the cooldown stop it retrying on every call.
        this.logger.error(`Embedding inference failed, using the lexical fallback: ${(err as Error).message}`);
        this.pipeline = null;
        this.pipelinePromise = null;
        this.nextModelAttemptAt = Date.now() + MODEL_RETRY_COOLDOWN_MS;
      }
    }

    this.activeVersion = HASH_EMBEDDING_MODEL_VERSION;
    return texts.map((t) => ({ vector: hashEmbedding(t), version: HASH_EMBEDDING_MODEL_VERSION }));
  }
}

export interface EmbeddingWithVersion {
  vector: number[];
  version: number;
}

// all-MiniLM-L6-v2 truncates at 256 word pieces anyway; clipping the text first keeps a huge input from
// costing tokenizer time.
function clip(text: string): string {
  return text.length > 2000 ? text.slice(0, 2000) : text;
}

const HASH_STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "in", "on", "at", "by", "for", "with", "from", "is", "are", "was", "were",
  "be", "it", "this", "that", "my", "me", "i", "you", "your", "what", "how", "much", "do", "does", "did",
]);

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic feature-hashing embedding: unigrams + bigrams (+ character trigrams for typo/stem
 * tolerance) hashed into EMBEDDING_DIMENSIONS buckets with a sign bit, sublinear term weighting, then
 * L2-normalised so cosine similarity works the same way as for the neural vectors. It captures lexical
 * overlap, not meaning — it is the safety net, not the primary model. Exported for tests. */
export function hashEmbedding(text: string): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .replace(/(\d),(?=\d)/g, "$1")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !HASH_STOP.has(w));

  const counts = new Map<string, number>();
  const add = (feature: string, weight: number) => counts.set(feature, (counts.get(feature) ?? 0) + weight);
  for (let i = 0; i < words.length; i++) {
    const w = words[i].length > 4 ? words[i].replace(/(ies|ing|ed|es|s)$/, "") : words[i];
    add(`w:${w}`, 1);
    if (i < words.length - 1) add(`b:${w}_${words[i + 1]}`, 0.7);
    if (w.length >= 5) for (let j = 0; j + 3 <= w.length; j++) add(`c:${w.slice(j, j + 3)}`, 0.15);
  }

  for (const [feature, count] of counts) {
    const h = fnv1a(feature);
    const index = h % EMBEDDING_DIMENSIONS;
    const sign = (h >>> 16) & 1 ? 1 : -1;
    vec[index] += sign * (1 + Math.log(count));
  }

  const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
  return norm === 0 ? vec : vec.map((v) => v / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors from embedBatch are already L2-normalized (pooling+normalize: true above),
  // so dot product alone equals cosine similarity — this function still divides by
  // the norms explicitly so it stays correct if ever called with un-normalized input.
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) normA += a[i] * a[i];
  for (let i = 0; i < b.length; i++) normB += b[i] * b[i];
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface EmbeddingPipeline {
  (text: string, options: { pooling: "mean"; normalize: boolean }): Promise<{ data: Float32Array }>;
}
