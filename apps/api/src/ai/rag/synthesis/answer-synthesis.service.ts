import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiUnavailableException, AiValidationException } from "../../exceptions/ai.exceptions";
import { RerankedChunk } from "../retrieval/reranking.service";

const synthesisSchema = z.object({
  hasEvidence: z
    .boolean()
    .describe("False if the provided sources do not actually contain enough to answer the question."),
  answer: z.string().describe("The answer, grounded only in the provided numbered sources. Empty string if hasEvidence is false."),
  citedIndices: z.array(z.number().int().min(0)).describe("Indices (from the numbered source list) actually used to compose the answer."),
});

export interface SynthesisResult {
  hasEvidence: boolean;
  answer: string;
  citedChunkIds: string[];
  confidence: number;
}

const NO_EVIDENCE_ANSWER =
  "I couldn't find anything in your documents, reports, coach history, or alerts that answers this — rather than guess, I'm telling you there's no evidence for it.";

// Distinct from NO_EVIDENCE_ANSWER on purpose: this path is only reached once `chunks`
// is already non-empty (real, retrieved evidence exists) — telling the user "nothing
// was found" here would be a straightforwardly false statement. This message instead
// reflects the true state: evidence exists, but the model call that turns it into
// plain-language prose is temporarily unavailable.
const AI_UNAVAILABLE_ANSWER =
  "I found information that looks relevant to your question, but the AI service that composes a plain-language answer from it is temporarily unavailable. See the source citations below in the meantime.";

@Injectable()
export class AnswerSynthesisService {
  private readonly logger = new Logger(AnswerSynthesisService.name);

  constructor(private gateway: AiGatewayService) {}

  /** `chunks` must already be the final, reranked set — this class does not re-filter
   * or re-order them, it only decides whether to trust them enough to answer at all
   * and, if so, composes the answer strictly from what's given. */
  async synthesize(userId: string, query: string, chunks: RerankedChunk[]): Promise<SynthesisResult> {
    if (chunks.length === 0) {
      return { hasEvidence: false, answer: NO_EVIDENCE_ANSWER, citedChunkIds: [], confidence: 1 };
    }

    const sourceList = chunks
      .map((c, i) => `[${i}] (${c.sourceType}, ${formatDate(c.sourceCreatedAt)}) ${c.text}`)
      .join("\n\n");

    const input = `Question: ${query}\n\nNumbered sources (answer ONLY using these, cite which you used):\n\n${sourceList}`;

    let result: Awaited<ReturnType<AiGatewayService["extract"]>>;
    try {
      result = await this.gateway.extract(input, synthesisSchema, {
        feature: "rag.synthesis",
        promptName: "rag.synthesis",
        userId,
        cacheable: false,
      });
    } catch (err) {
      // Synthesis is the ONE gateway call in the RAG pipeline (query rewrite,
      // reranking, synthesis) that previously had no fallback — an AiUnavailableException
      // (Groq down/timeout) or AiValidationException (model never produced schema-valid
      // JSON after retries) propagated straight past RagService and RagController
      // uncaught, surfacing as a raw 503/502 to the user and throwing away the
      // retrieval + reranking work already done for this request. Every other AI call
      // in this app degrades gracefully on these two exception types (see
      // QueryRewriteService.plan(), RerankingService.rerank(),
      // CategorySuggestionService.suggest(), etc.) — this brings synthesis in line with
      // that same, otherwise-consistent pattern. Anything else (a genuine bug) still
      // propagates rather than being silently masked.
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        this.logger.warn(`Answer synthesis unavailable for a query with ${chunks.length} retrieved chunk(s): ${err.message}`);
        return {
          hasEvidence: true,
          answer: AI_UNAVAILABLE_ANSWER,
          // We can't know which chunks the model would have cited, but real evidence
          // was retrieved — surface all of it rather than an empty citation list, so
          // the caller/UI can still show the user what was found.
          citedChunkIds: chunks.map((c) => c.id),
          confidence: 0,
        };
      }
      throw err;
    }

    if (!result.data.hasEvidence) {
      return { hasEvidence: false, answer: NO_EVIDENCE_ANSWER, citedChunkIds: [], confidence: result.confidence };
    }

    const citedChunkIds = result.data.citedIndices
      .filter((i) => i >= 0 && i < chunks.length)
      .map((i) => chunks[i].id);

    return {
      hasEvidence: true,
      answer: result.data.answer,
      // If the model claimed evidence but cited nothing, that's an inconsistent
      // response — don't let an uncited answer through as if it were grounded; treat
      // it as having cited everything it was given instead, since it did produce an
      // answer from exactly this source list and provenance should never be silently
      // empty for an answer that claims to be grounded.
      citedChunkIds: citedChunkIds.length > 0 ? citedChunkIds : chunks.map((c) => c.id),
      confidence: result.confidence,
    };
  }
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
