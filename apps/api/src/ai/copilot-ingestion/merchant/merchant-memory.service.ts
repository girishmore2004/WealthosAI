import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import { EmbeddingService, cosineSimilarity } from "../../rag/embedding/embedding.service";
import {
  ACTIVE_LEARNING_CONFIDENCE_THRESHOLD,
  ACTIVE_LEARNING_MIN_SAMPLE_SIZE,
  GLOBAL_STAT_MAX_CONFIDENCE,
  GLOBAL_STAT_SMOOTHING_K,
  MERCHANT_MEMORY_DECAY_HALF_LIFE_DAYS,
  MERCHANT_MEMORY_FUZZY_CANDIDATE_LIMIT,
  MERCHANT_MEMORY_FUZZY_MATCH_THRESHOLD,
  MERCHANT_MEMORY_INITIAL_CONFIDENCE,
  MERCHANT_MEMORY_LEARNING_STEP,
  MERCHANT_MEMORY_MAX_CONFIDENCE,
  MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR,
  MERCHANT_MEMORY_OVERRIDE_SWITCH_RATIO,
  MIN_GLOBAL_STAT_SAMPLES_FOR_SIGNAL,
} from "../copilot-ingestion.constants";

export interface MerchantMemoryEntry {
  categoryId: string;
  categoryName: string;
  /** Already decayed for elapsed time since lastAcceptedAt — callers never need to
   * apply decay themselves. */
  confidence: number;
  sampleSize: number; // acceptedCount + overrideCount
  matchType: "exact" | "fuzzy";
}

export interface GlobalStatEntry {
  categoryName: string;
  confidence: number;
  sampleCount: number;
}

// A conservative, best-effort guard against ever writing something PII-shaped into the
// cross-user GlobalStat table — merchant text is already regex-cleaned by
// normalizeMerchantText() before it reaches here, but statement text is
// user-authored/OCR'd and occasionally a phone number, card fragment, or reference code
// survives normalization (e.g. a merchant string with an embedded UPI handle). This is
// deliberately NOT a reuse of RedactionService's rules (that class lives in AiModule,
// which does not export it — see copilot-ingestion.module.ts's own doc comment on why
// this feature duplicates rather than widens another feature's module exports) but a
// narrower, purpose-built check: it only needs to decide "safe to share anonymously
// across users, yes/no", not produce a redacted replacement string.
const GLOBAL_STAT_UNSAFE_PATTERNS: RegExp[] = [
  /\d{9,}/, // any long digit run (phone/card/account-shaped)
  /@[\w.-]+/, // an @handle (UPI id, email-shaped)
  /\b[A-Z]{5}\d{4}[A-Z]\b/, // PAN-shaped
];

function looksSafeForGlobalSharing(merchantNormalized: string): boolean {
  return !GLOBAL_STAT_UNSAFE_PATTERNS.some((p) => p.test(merchantNormalized));
}

function decayedConfidence(baseConfidence: number, lastAcceptedAt: Date): number {
  const daysSince = Math.max(0, (Date.now() - lastAcceptedAt.getTime()) / (1000 * 60 * 60 * 24));
  const decayFactor = Math.pow(0.5, daysSince / MERCHANT_MEMORY_DECAY_HALF_LIFE_DAYS);
  return baseConfidence * decayFactor;
}

@Injectable()
export class MerchantMemoryService {
  private readonly logger = new Logger(MerchantMemoryService.name);

  constructor(
    private prisma: PrismaService,
    private embedding: EmbeddingService,
  ) {}

  /** Exact normalized-merchant lookup — the common, cheap path (no embedding call). */
  async lookup(userId: string, merchantNormalized: string): Promise<MerchantMemoryEntry | null> {
    const row = await this.prisma.client.merchantCategoryMemory.findUnique({
      where: { userId_merchantNormalized: { userId, merchantNormalized } },
    });
    if (!row) return null;

    const confidence = decayedConfidence(Number(row.confidence), row.lastAcceptedAt);
    if (confidence < MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR) {
      this.logger.debug(`Merchant memory for "${merchantNormalized}" decayed below the reliability floor — ignoring.`);
      return null;
    }

    return {
      categoryId: row.categoryId,
      categoryName: row.categoryName,
      confidence,
      sampleSize: row.acceptedCount + row.overrideCount,
      matchType: "exact",
    };
  }

  /** Embedding-similarity fallback for merchant strings that are near-variants of a
   * previously-seen one (e.g. a slightly different reference-number leftover, or a
   * genuinely different raw spelling of the same business) but don't share an exact
   * normalized key. Only called by CategorySuggestionService when `lookup()` above
   * returns nothing at all, keeping the extra embedding call off the common repeat-
   * merchant path. */
  async lookupFuzzy(userId: string, merchantNormalized: string): Promise<MerchantMemoryEntry | null> {
    const candidates = await this.prisma.client.merchantCategoryMemory.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: MERCHANT_MEMORY_FUZZY_CANDIDATE_LIMIT,
    });
    if (candidates.length === 0) return null;

    let queryEmbedding: number[];
    try {
      queryEmbedding = await this.embedding.embed(merchantNormalized);
    } catch (err) {
      // Embedding is in-process WASM inference — it can fail (model not yet loaded,
      // OOM) independently of Groq. Fuzzy matching is a nice-to-have refinement, not a
      // step CategorySuggestionService's fallback chain depends on being available —
      // failing here just means "no fuzzy match found," never an unhandled rejection.
      this.logger.warn(`Fuzzy merchant memory lookup failed to embed "${merchantNormalized}": ${(err as Error).message}`);
      return null;
    }

    let best: { row: (typeof candidates)[number]; similarity: number } | null = null;
    for (const row of candidates) {
      if (row.embedding.length === 0) continue;
      const similarity = cosineSimilarity(queryEmbedding, row.embedding);
      if (similarity >= MERCHANT_MEMORY_FUZZY_MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
        best = { row, similarity };
      }
    }
    if (!best) return null;

    const confidence = decayedConfidence(Number(best.row.confidence), best.row.lastAcceptedAt) * best.similarity;
    if (confidence < MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR) return null;

    return {
      categoryId: best.row.categoryId,
      categoryName: best.row.categoryName,
      confidence,
      sampleSize: best.row.acceptedCount + best.row.overrideCount,
      matchType: "fuzzy",
    };
  }

  /** Cross-user, privacy-safe prior: which category name has this normalized merchant
   * most often resolved to across every user's approvals, Laplace-smoothed so a
   * 1-2-sample stat can never look confident. Resolved against the CALLING user's own
   * category list by name (categories are per-user rows; only the name is shared) —
   * if no category with that name exists in this user's account, there is nothing
   * useful to return. */
  async globalLookup(merchantNormalized: string, categories: { id: string; name: string }[]): Promise<GlobalStatEntry | null> {
    const rows = await this.prisma.client.merchantCategoryGlobalStat.findMany({
      where: { merchantNormalized },
      orderBy: { count: "desc" },
      take: 5,
    });
    if (rows.length === 0) return null;

    const totalSamples = rows.reduce((sum, r) => sum + r.count, 0);
    if (totalSamples < MIN_GLOBAL_STAT_SAMPLES_FOR_SIGNAL) return null;

    const top = rows[0];
    const matchingCategory = categories.find((c) => c.name.toLowerCase() === top.categoryName.toLowerCase());
    if (!matchingCategory) return null;

    const confidence = Math.min(GLOBAL_STAT_MAX_CONFIDENCE, top.count / (top.count + GLOBAL_STAT_SMOOTHING_K));
    return { categoryName: matchingCategory.name, confidence, sampleCount: top.count };
  }

  /** The learning write path — called only from IngestionReviewService#approve(),
   * i.e. only on a real human decision, never on an unverified AI guess. Updates (or
   * creates) this user's personal memory row and bumps the anonymous global stat. */
  async recordFeedback(
    userId: string,
    merchantNormalized: string,
    finalCategoryId: string,
    finalCategoryName: string,
  ): Promise<void> {
    const existing = await this.prisma.client.merchantCategoryMemory.findUnique({
      where: { userId_merchantNormalized: { userId, merchantNormalized } },
    });

    if (!existing) {
      let embedding: number[] = [];
      try {
        embedding = await this.embedding.embed(merchantNormalized);
      } catch (err) {
        // No embedding yet is fine — this row simply won't participate in fuzzy
        // matching for other merchants until a later reconciliation pass re-embeds it;
        // it still works perfectly for exact-key lookups in the meantime.
        this.logger.warn(`Could not embed new merchant memory entry for "${merchantNormalized}": ${(err as Error).message}`);
      }
      await this.prisma.client.merchantCategoryMemory.create({
        data: {
          userId,
          merchantNormalized,
          categoryId: finalCategoryId,
          categoryName: finalCategoryName,
          confidence: MERCHANT_MEMORY_INITIAL_CONFIDENCE,
          acceptedCount: 1,
          overrideCount: 0,
          embedding,
          lastAcceptedAt: new Date(),
        },
      });
    } else if (existing.categoryId === finalCategoryId) {
      // Agreement — reinforce.
      const currentConfidence = decayedConfidence(Number(existing.confidence), existing.lastAcceptedAt);
      const newConfidence = Math.min(
        MERCHANT_MEMORY_MAX_CONFIDENCE,
        currentConfidence + MERCHANT_MEMORY_LEARNING_STEP * (MERCHANT_MEMORY_MAX_CONFIDENCE - currentConfidence),
      );
      await this.prisma.client.merchantCategoryMemory.update({
        where: { id: existing.id },
        data: { confidence: newConfidence, acceptedCount: { increment: 1 }, lastAcceptedAt: new Date() },
      });
    } else {
      // Correction — the human chose a different category than memory's mapping.
      const newOverrideCount = existing.overrideCount + 1;
      const shouldSwitch = newOverrideCount >= existing.acceptedCount * MERCHANT_MEMORY_OVERRIDE_SWITCH_RATIO;

      if (shouldSwitch) {
        // The correction pattern has become the dominant signal for this merchant —
        // relearn it as the new mapping rather than continuing to decay a mapping the
        // human keeps rejecting. Re-embedding on switch keeps the fuzzy-match anchor
        // accurate even though merchantNormalized itself is unchanged (embedding text
        // doesn't depend on category, so this is really just re-establishing sample
        // counts/confidence for a fresh mapping cycle, not a new embedding value —
        // the existing embedding is reused rather than re-computed, which is correct:
        // the text being embedded, the merchant string, hasn't changed).
        await this.prisma.client.merchantCategoryMemory.update({
          where: { id: existing.id },
          data: {
            categoryId: finalCategoryId,
            categoryName: finalCategoryName,
            confidence: MERCHANT_MEMORY_INITIAL_CONFIDENCE,
            acceptedCount: 1,
            overrideCount: 0,
            lastAcceptedAt: new Date(),
          },
        });
      } else {
        const currentConfidence = decayedConfidence(Number(existing.confidence), existing.lastAcceptedAt);
        const newConfidence = Math.max(
          MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR,
          currentConfidence - MERCHANT_MEMORY_LEARNING_STEP * (currentConfidence - MERCHANT_MEMORY_MIN_CONFIDENCE_FLOOR),
        );
        await this.prisma.client.merchantCategoryMemory.update({
          where: { id: existing.id },
          data: { confidence: newConfidence, overrideCount: newOverrideCount, lastAcceptedAt: existing.lastAcceptedAt },
        });
      }
    }

    await this.bumpGlobalStat(merchantNormalized, finalCategoryName);
  }

  private async bumpGlobalStat(merchantNormalized: string, categoryName: string): Promise<void> {
    if (!looksSafeForGlobalSharing(merchantNormalized)) {
      this.logger.debug("Skipped global merchant stat write — normalized merchant text failed the PII-shape guard.");
      return;
    }
    try {
      await this.prisma.client.merchantCategoryGlobalStat.upsert({
        where: { merchantNormalized_categoryName: { merchantNormalized, categoryName } },
        create: { merchantNormalized, categoryName, count: 1 },
        update: { count: { increment: 1 } },
      });
    } catch (err) {
      // Fire-and-forget by design: the global stat is a nice-to-have shared prior, not
      // something any single ingestion request should ever fail over.
      this.logger.warn(`Failed to update global merchant stat for "${merchantNormalized}": ${(err as Error).message}`);
    }
  }

  /** Whether this suggestion (regardless of its raw confidence number) should be
   * queued for prioritized human attention — either genuinely unestablished (few
   * samples) or below the confidence bar even after decay/blending. Used by
   * SuggestionScoringService to set IngestionReviewItem.needsActiveLearningReview. */
  needsActiveLearningReview(entry: MerchantMemoryEntry | null, blendedConfidence: number): boolean {
    if (!entry) return blendedConfidence < ACTIVE_LEARNING_CONFIDENCE_THRESHOLD;
    return entry.sampleSize < ACTIVE_LEARNING_MIN_SAMPLE_SIZE || blendedConfidence < ACTIVE_LEARNING_CONFIDENCE_THRESHOLD;
  }
}
