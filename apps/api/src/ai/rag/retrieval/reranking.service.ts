import { Injectable, Logger } from "@nestjs/common";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException } from "../../exceptions/ai.exceptions";
import { ScoredChunk } from "./hybrid-retrieval.service";
import { TOP_K_RERANKED } from "../rag.constants";

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

@Injectable()
export class RerankingService {
  private readonly logger = new Logger(RerankingService.name);

  constructor(private gateway: AiGatewayService) {}

  async rerank(userId: string, query: string, candidates: ScoredChunk[]): Promise<RerankResult> {
    if (candidates.length === 0) {
      return { chunks: [], rationale: "No candidates to rerank.", confidence: 0 };
    }
    if (candidates.length === 1) {
      return { chunks: [{ ...candidates[0], rerankPosition: 0 }], rationale: "Only one candidate.", confidence: candidates[0].semanticScore };
    }

    try {
      const items = candidates.map((c) => truncate(`[${c.sourceType}] ${c.text}`, MAX_CHUNK_CHARS_FOR_RERANK));
      const result = await this.gateway.rank(items, `Most relevant to answering: "${query}"`, {
        feature: "rag.rerank",
        promptName: "rag.rerank",
        userId,
        cacheable: false, // candidate set composition varies call to call, caching would rarely hit anyway
      });

      const validIndices = result.data.orderedIndices.filter((i) => i >= 0 && i < candidates.length);
      // The model might omit or duplicate indices — fall back to hybrid retrieval's
      // own ordering for anything it didn't cleanly rank, rather than dropping
      // candidates it forgot to mention.
      const seen = new Set(validIndices);
      const remainder = candidates.map((_, i) => i).filter((i) => !seen.has(i));
      const finalOrder = [...validIndices, ...remainder];

      const chunks = finalOrder
        .slice(0, TOP_K_RERANKED)
        .map((candidateIndex, position) => ({ ...candidates[candidateIndex], rerankPosition: position }));

      return { chunks, rationale: result.data.rationale, confidence: result.confidence };
    } catch (err) {
      // Reranking is an enhancement over hybrid retrieval's own ordering, not a hard
      // dependency — fall back to the combined-score order already computed rather
      // than failing the whole search when the rerank call itself is unavailable.
      if (err instanceof AiUnavailableException || err instanceof Error) {
        this.logger.warn(`Reranking unavailable, falling back to hybrid retrieval order: ${(err as Error).message}`);
        const chunks = candidates
          .slice(0, TOP_K_RERANKED)
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
