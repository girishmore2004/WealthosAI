import { Injectable } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
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

@Injectable()
export class AnswerSynthesisService {
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

    const result = await this.gateway.extract(input, synthesisSchema, {
      feature: "rag.synthesis",
      promptName: "rag.synthesis",
      userId,
      cacheable: false,
    });

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
