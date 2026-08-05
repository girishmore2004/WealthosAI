import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../../prisma/prisma.service";
import {
  SUGGESTION_RANKING_DEFAULT_WEIGHTS,
  SUGGESTION_RANKING_LEARNING_RATE,
  SUGGESTION_RANKING_MAX_WEIGHT,
  SUGGESTION_RANKING_MIN_WEIGHT,
} from "../copilot-ingestion.constants";

export type RankingSource = "memory" | "ai" | "global";
export type SuggestionSource = RankingSource | "blended" | "rule_based_fallback" | "none";

export interface RankingCandidate {
  categoryId: string;
  categoryName: string;
  confidence: number; // 0-1
}

export interface RankingCandidates {
  memory: RankingCandidate | null;
  ai: RankingCandidate | null;
  global: RankingCandidate | null;
}

export interface RankedSuggestion {
  categoryId: string;
  categoryName: string;
  confidence: number;
  source: SuggestionSource;
}

interface RankingWeights {
  memory: number;
  ai: number;
  global: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalize(weights: RankingWeights): RankingWeights {
  const total = weights.memory + weights.ai + weights.global;
  if (total <= 0) return { ...SUGGESTION_RANKING_DEFAULT_WEIGHTS };
  return { memory: weights.memory / total, ai: weights.ai / total, global: weights.global / total };
}

// A deliberately simple, transparent linear weighted-vote "ranking model" — each of
// the (at most three) category candidates CategorySuggestionService assembles
// (personal merchant memory, the AI Gateway's classify() result, the cross-user global
// stat prior) contributes weight_source * candidate_confidence toward its category's
// total score; the highest-scoring category wins. Per-user weights start at
// SUGGESTION_RANKING_DEFAULT_WEIGHTS and are nudged after every human approval/
// override (see learnFromCorrection) — "learns from corrections" in the same spirit as
// this codebase's other classical-statistics models (MAD anomaly z-score, OLS
// regression, Welch's t-test): a small number of interpretable parameters updated by a
// hand-verifiable rule, not an opaque model. Structurally cannot invent a category: it
// only ever picks among the categoryIds present in the candidates it was given, and
// every candidate CategorySuggestionService constructs is already validated against
// the caller's own category list before reaching here.
@Injectable()
export class CategoryRankingModel {
  constructor(private prisma: PrismaService) {}

  async rank(userId: string, candidates: RankingCandidates): Promise<RankedSuggestion | null> {
    if (!candidates.memory && !candidates.ai && !candidates.global) return null;

    const weights = normalize(await this.getRawWeights(userId));

    const scored = new Map<string, { score: number; categoryName: string; sources: Set<RankingSource> }>();
    const contribute = (candidate: RankingCandidate | null, source: RankingSource, weight: number) => {
      if (!candidate) return;
      const entry = scored.get(candidate.categoryId) ?? { score: 0, categoryName: candidate.categoryName, sources: new Set<RankingSource>() };
      entry.score += weight * candidate.confidence;
      entry.sources.add(source);
      scored.set(candidate.categoryId, entry);
    };

    contribute(candidates.memory, "memory", weights.memory);
    contribute(candidates.ai, "ai", weights.ai);
    contribute(candidates.global, "global", weights.global);

    let best: [string, { score: number; categoryName: string; sources: Set<RankingSource> }] | null = null;
    for (const entry of scored.entries()) {
      if (!best || entry[1].score > best[1].score) best = entry;
    }
    if (!best) return null;

    const [categoryId, info] = best;
    const source: SuggestionSource = info.sources.size > 1 ? "blended" : [...info.sources][0];
    return { categoryId, categoryName: info.categoryName, confidence: clamp(info.score, 0, 1), source };
  }

  /** Called once per approved/overridden review item (see IngestionReviewService).
   * `winningSource` is whichever source originally produced the suggestion the item
   * showed the human (item.suggestionSource); `wasCorrect` is whether the human's
   * final category matches that suggestion. A rule-based-fallback or "no suggestion"
   * outcome is not attributable to any of the three ranked sources and is a no-op here
   * — there is no weight to adjust for a source that wasn't part of the ranking. */
  async learnFromCorrection(userId: string, winningSource: SuggestionSource, wasCorrect: boolean): Promise<void> {
    if (winningSource !== "memory" && winningSource !== "ai" && winningSource !== "global") return;

    const raw = await this.getRawWeights(userId);
    const updated = { ...raw };

    if (wasCorrect) {
      updated[winningSource] = clamp(
        updated[winningSource] + SUGGESTION_RANKING_LEARNING_RATE * (SUGGESTION_RANKING_MAX_WEIGHT - updated[winningSource]),
        SUGGESTION_RANKING_MIN_WEIGHT,
        SUGGESTION_RANKING_MAX_WEIGHT,
      );
    } else {
      updated[winningSource] = clamp(
        updated[winningSource] - SUGGESTION_RANKING_LEARNING_RATE * (updated[winningSource] - SUGGESTION_RANKING_MIN_WEIGHT),
        SUGGESTION_RANKING_MIN_WEIGHT,
        SUGGESTION_RANKING_MAX_WEIGHT,
      );
    }

    await this.prisma.client.suggestionRankingProfile.upsert({
      where: { userId },
      create: {
        userId,
        weightMemory: updated.memory,
        weightAi: updated.ai,
        weightGlobal: updated.global,
        sampleCount: 1,
      },
      update: {
        weightMemory: updated.memory,
        weightAi: updated.ai,
        weightGlobal: updated.global,
        sampleCount: { increment: 1 },
      },
    });
  }

  private async getRawWeights(userId: string): Promise<RankingWeights> {
    const row = await this.prisma.client.suggestionRankingProfile.findUnique({ where: { userId } });
    if (!row) return { ...SUGGESTION_RANKING_DEFAULT_WEIGHTS };
    return { memory: Number(row.weightMemory), ai: Number(row.weightAi), global: Number(row.weightGlobal) };
  }
}
