import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { AiGroundingException, AiUnavailableException, AiValidationException } from "../../exceptions/ai.exceptions";
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
  /** 0-1, or null when grounding couldn't be scored (e.g. an AiUnavailable fallback
   * before any model response existed to score). See GroundingService. Distinct from
   * `confidence`, which is the model's own self-report — this is the gateway's
   * independent, deterministic check of whether the answer's own numbers actually
   * appear in the retrieved chunks it was given. */
  groundingScore: number | null;
  hallucinationRisk: "unmeasured" | "low" | "medium" | "high";
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

// Distinct again from both messages above: the model DID answer, and the answer WAS
// schema-valid, but it introduced a figure the gateway's grounding check couldn't
// find anywhere in the retrieved evidence even after one corrective retry — i.e. a
// probable numeric hallucination. Serving that answer anyway would be exactly the
// failure mode this whole pipeline exists to prevent, so this degrades the same way
// AI_UNAVAILABLE_ANSWER does: real evidence is still surfaced via citations, just
// without AI-composed prose vouching for numbers that didn't check out.
const GROUNDING_FAILED_ANSWER =
  "I found information that looks relevant to your question, but the AI-composed answer introduced figures I couldn't verify against your actual data, so I'm not showing it. See the source citations below instead.";

@Injectable()
export class AnswerSynthesisService {
  private readonly logger = new Logger(AnswerSynthesisService.name);

  constructor(private gateway: AiGatewayService) {}

  /** `chunks` must already be the final, reranked set (Layer 4's output) — this class
   * does not re-filter or re-order them, it only decides whether to trust them enough
   * to answer at all and, if so, composes the answer strictly from what's given
   * (Layer 5). Numeric grounding: every call passes `groundingContext` (built from
   * each cited chunk's *parent* text, not just its narrow child text — "contextual
   * chunk expansion" applied specifically here, so a number that's technically in the
   * source but fell just outside the precise matched window still counts as grounded)
   * and `rejectOnLowGrounding: true`, so the gateway itself rejects-and-retries an
   * answer that introduces figures not present anywhere in the retrieved evidence,
   * throwing AiGroundingException if a corrective retry still doesn't fix it — see
   * GROUNDING_FAILED_ANSWER below for that degrade path. */
  async synthesize(userId: string, query: string, chunks: RerankedChunk[]): Promise<SynthesisResult> {
    if (chunks.length === 0) {
      return { hasEvidence: false, answer: NO_EVIDENCE_ANSWER, citedChunkIds: [], confidence: 1, groundingScore: null, hallucinationRisk: "unmeasured" };
    }

    const sourceList = chunks
      .map((c, i) => `[${i}] (${c.sourceType}, ${formatDate(c.sourceCreatedAt)}) ${c.text}`)
      .join("\n\n");

    const input = `Question: ${query}\n\nNumbered sources (answer ONLY using these, cite which you used):\n\n${sourceList}`;
    const groundingContext = buildGroundingContext(chunks);

    let result: Awaited<ReturnType<AiGatewayService["extract"]>>;
    try {
      result = await this.gateway.extract(input, synthesisSchema, {
        feature: "rag.synthesis",
        promptName: "rag.synthesis",
        userId,
        cacheable: false,
        groundingContext,
        rejectOnLowGrounding: true,
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
      // that same, otherwise-consistent pattern. AiGroundingException (thrown only
      // because this call opted into `rejectOnLowGrounding: true` above) degrades the
      // same way, via GROUNDING_FAILED_ANSWER instead of AI_UNAVAILABLE_ANSWER, since
      // the failure mode is different (the model answered, the answer just didn't
      // check out numerically). Anything else (a genuine bug) still propagates rather
      // than being silently masked.
      if (err instanceof AiGroundingException) {
        this.logger.warn(`Answer synthesis failed grounding verification for a query with ${chunks.length} retrieved chunk(s): ${err.message}`);
        return {
          hasEvidence: true,
          answer: GROUNDING_FAILED_ANSWER,
          citedChunkIds: chunks.map((c) => c.id),
          confidence: 0,
          groundingScore: 0,
          hallucinationRisk: "high",
        };
      }
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
          groundingScore: null,
          hallucinationRisk: "unmeasured",
        };
      }
      throw err;
    }

    if (!result.data.hasEvidence) {
      return {
        hasEvidence: false,
        answer: NO_EVIDENCE_ANSWER,
        citedChunkIds: [],
        confidence: result.confidence,
        groundingScore: result.groundingScore,
        hallucinationRisk: result.hallucinationRisk,
      };
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
      groundingScore: result.groundingScore,
      hallucinationRisk: result.hallucinationRisk,
    };
  }
}

/** Broader than `sourceList` above on purpose: uses each cited chunk's *parent* text
 * (the larger section it was extracted from at index time, see ChunkerService)
 * instead of just the narrow child chunk, deduplicated per (sourceType, sourceId) so
 * a source with several cited chunks doesn't repeat its own parent text multiple
 * times in the context the grounding check compares against. This is "numeric claims
 * in answers are grounded in retrieved chunks" applied with real headroom: a figure
 * that's genuinely in the source document but fell just outside the precise ~180-word
 * window that won the similarity search still passes grounding, rather than the
 * synthesis model being penalized for citing a true number the narrow child chunk
 * alone didn't happen to contain. */
function buildGroundingContext(chunks: RerankedChunk[]): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const chunk of chunks) {
    const key = `${chunk.sourceType}:${chunk.sourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(chunk.parentText || chunk.text);
  }
  return parts.join("\n\n");
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
