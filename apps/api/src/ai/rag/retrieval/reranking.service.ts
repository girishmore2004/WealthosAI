import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ScoredChunk } from "./hybrid-retrieval.service";
import { MAX_RERANK_INPUT_ITEMS, TOP_K_RERANKED } from "../rag.constants";

export interface RerankedChunk extends ScoredChunk {
  rerankPosition: number;
}

export interface RerankResult {
  chunks: RerankedChunk[];
  rationale: string;
  /** The reranker's own self-reported confidence in its ordering — distinct from
   * retrieval's semantic-similarity-derived confidence and from the final answer's
   * synthesis confidence; RagService combines all relevant signals into one reported
   * number rather than picking just one. */
  confidence: number;
}

const MAX_CHUNK_CHARS_FOR_RERANK = 500;

// Layer 4: cross-document reranking. `candidates` may span every source type/document
// hybrid retrieval (and its Layer 3 relationship expansion) pulled in — this is what
// makes it "cross-document": the model orders the whole mixed pool by relevance to
// the question, not per-source.
@Injectable()
export class RerankingService {
  private readonly logger = new Logger(RerankingService.name);

  constructor(private gateway: AiGatewayService) {}

  /** `rerankLimit` defaults to TOP_K_RERANKED (this feature's original fixed value)
   * but callers pass RagService's adaptiveRerankLimit(complexity) result so a complex
   * question keeps more chunks for synthesis than a simple one — "adaptive top-k
   * based on query complexity" applied at the output end of reranking, mirroring the
   * adaptive candidate limit already applied at hybrid retrieval's input end. */
  async rerank(userId: string, query: string, candidates: ScoredChunk[], rerankLimit: number = TOP_K_RERANKED): Promise<RerankResult> {
    if (candidates.length === 0) {
      return { chunks: [], rationale: "No candidates to rerank.", confidence: 0 };
    }
    if (candidates.length === 1) {
      return { chunks: [{ ...candidates[0], rerankPosition: 0 }], rationale: "Only one candidate.", confidence: candidates[0].semanticScore };
    }

    // Regardless of how wide the candidate pool got (adaptive top-k can go up to
    // MAX_CANDIDATES, plus Layer 3 expansions on top of that), only the first
    // MAX_RERANK_INPUT_ITEMS candidates are ever sent to the LLM reranker — bounds
    // this one real model call's latency/token cost independently of how wide
    // earlier layers cast their net. The remainder still participates in the
    // fallback ordering below if reranking itself is unavailable.
    //
    // Deliberately NOT re-sorted by combinedScore here: the model's orderedIndices
    // response refers to positions in whatever array we send it, so re-sorting
    // `rerankInput` after computing it (or sorting it before sending) would make our
    // own index bookkeeping diverge from the model's — the caller is expected to hand
    // candidates in through already in the order that matters.
    const rerankInput = candidates.slice(0, MAX_RERANK_INPUT_ITEMS);

    try {
      const items = rerankInput.map((c) => truncate(`[${c.sourceType}] ${c.text}`, MAX_CHUNK_CHARS_FOR_RERANK));
      const result = await this.gateway.rank(items, `Most relevant to answering: "${query}"`, {
        feature: "rag.rerank",
        promptName: "rag.rerank",
        userId,
        cacheable: false, // candidate set composition varies call to call, caching would rarely hit anyway
      });

      const validIndices = result.data.orderedIndices.filter((i) => i >= 0 && i < rerankInput.length);
      // The model might omit indices it didn't mention, OR duplicate one it mentioned
      // more than once — both are handled here. Omitted indices fall back to hybrid
      // retrieval's own ordering (via `remainder`, below). Duplicates are collapsed to
      // their first occurrence: without this, a repeated index would occupy multiple
      // slots in `finalOrder`, wasting a rerank-limit slot on the same chunk twice
      // and silently pushing a genuinely distinct, already-retrieved candidate out of
      // the context handed to answer synthesis.
      const seen = new Set<number>();
      const dedupedValidIndices: number[] = [];
      for (const i of validIndices) {
        if (!seen.has(i)) {
          seen.add(i);
          dedupedValidIndices.push(i);
        }
      }
      const remainder = rerankInput.map((_, i) => i).filter((i) => !seen.has(i));
      const finalOrder = [...dedupedValidIndices, ...remainder];

      const chunks = finalOrder
        .slice(0, rerankLimit)
        .map((candidateIndex, position) => ({ ...rerankInput[candidateIndex], rerankPosition: position }));

      return { chunks, rationale: result.data.rationale, confidence: result.confidence };
    } catch (err) {
      // Reranking is an enhancement over hybrid retrieval's own ordering, not a hard
      // dependency — fall back to the combined-score order already computed rather
      // than failing the whole search when the rerank call itself is unavailable.
      if (err instanceof AiUnavailableException || err instanceof Error) {
        this.logger.warn(`Reranking unavailable, falling back to hybrid retrieval order: ${(err as Error).message}`);
        const chunks = [...candidates]
          .sort((a, b) => b.combinedScore - a.combinedScore)
          .slice(0, rerankLimit)
          .map((c, position) => ({ ...c, rerankPosition: position }));
        return { chunks, rationale: "Reranking was unavailable; ordered by hybrid retrieval score instead.", confidence: chunks[0]?.semanticScore ?? 0 };
      }
      throw err;
    }
  }
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars) + "…";
}
