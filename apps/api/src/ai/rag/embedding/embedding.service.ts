import { Injectable, Logger } from "@nestjs/common";

export const EMBEDDING_DIMENSIONS = 384;

// Runs entirely in-process (WASM), no Groq/external inference call — embeddings are
// cheap enough that CPU-only local inference is genuinely practical, unlike the
// larger generation/reasoning models this app routes to Groq instead. Model:
// Xenova/all-MiniLM-L6-v2, a widely used 384-dim sentence-embedding model, ~90MB.
//
// NOTE: the underlying @xenova/transformers library downloads the model weights from
// huggingface.co on first use and caches them to disk (default: ./node_modules/
// @xenova/transformers/.cache, override via env var TRANSFORMERS_CACHE) — this
// requires outbound network access to huggingface.co the *first* time a process
// embeds anything, not on every call. This build environment's network egress does
// not include huggingface.co, so — same caveat as GroqClient in Phase 10 — this class
// is written correctly against the library's documented API but has not been
// exercised end-to-end here. Make sure your deployment target (a) has one-time
// internet egress to huggingface.co, or bake the model into the Docker image ahead of
// time, and (b) has persistent-enough disk for the cache, or accept re-downloading
// ~90MB on every cold start.
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  // The transformers.js pipeline is expensive to construct (loads model weights into
  // memory) — a module-level singleton promise so concurrent callers all await the
  // same load rather than racing to construct it multiple times.
  private pipelinePromise: Promise<EmbeddingPipeline> | null = null;

  private async getPipeline(): Promise<EmbeddingPipeline> {
    if (!this.pipelinePromise) {
      this.pipelinePromise = import("@xenova/transformers").then(({ pipeline }) =>
        pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2") as unknown as Promise<EmbeddingPipeline>,
      );
      this.pipelinePromise.catch((err) => {
        this.logger.error(`Failed to load embedding model: ${(err as Error).message}`);
        this.pipelinePromise = null; // allow a later retry rather than caching a permanent failure
      });
    }
    return this.pipelinePromise;
  }

  async embed(text: string): Promise<number[]> {
    const [vector] = await this.embedBatch([text]);
    return vector;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const results: number[][] = [];
    // Sequential rather than Promise.all — the WASM backend is single-threaded per
    // pipeline instance, running these concurrently wouldn't parallelize the actual
    // compute and would just interleave allocations. Fine for the batch sizes a
    // per-user reindex job produces (tens to low hundreds of chunks).
    for (const text of texts) {
      const output = await extractor(text, { pooling: "mean", normalize: true });
      results.push(Array.from(output.data as Float32Array));
    }
    return results;
  }
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
