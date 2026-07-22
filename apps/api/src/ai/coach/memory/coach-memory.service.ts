import { Injectable } from "@nestjs/common";
import { createHash } from "crypto";
import { PrismaService } from "../../../prisma/prisma.service";
import { CoachPath } from "@wealthos/db";

export interface RecordRunInput {
  userId: string;
  question: string;
  path: CoachPath;
  matchedIntent: string | null;
  advancedIntent: string | null;
  plan: string[];
  facts: Record<string, unknown>;
  citedSources: string[];
  answer: string;
  confidence: number;
  verificationPassed: boolean;
}

@Injectable()
export class CoachMemoryService {
  constructor(private prisma: PrismaService) {}

  /** Compares this run's facts against the most recent prior run for the same intent
   * (same user, same matched/advanced intent) and returns a note if either (a) the
   * facts are identical to last time — the user is asking something they already
   * asked and nothing in their data has changed, or (b) the facts differ — the
   * answer they'd remember from before is now out of date. Returns null when there is
   * no prior run to compare against (first time this intent has come up) or the
   * comparison isn't meaningful. This is what stands in for "remember previous advice
   * and avoid repeating itself" / "detect when advice is stale" from the roadmap —
   * genuinely comparing stored facts, not just checking if the question string
   * repeats. */
  async checkForStaleOrRepeatedAdvice(
    userId: string,
    intentKey: { matchedIntent: string | null; advancedIntent: string | null },
    currentFacts: Record<string, unknown>,
  ): Promise<string | null> {
    const previous = await this.prisma.client.agenticCoachRun.findFirst({
      where: {
        userId,
        matchedIntent: intentKey.matchedIntent,
        advancedIntent: intentKey.advancedIntent,
      },
      orderBy: { createdAt: "desc" },
    });

    if (!previous) return null;

    const currentHash = hashFacts(currentFacts);
    const previousHash = hashFacts(previous.facts as Record<string, unknown>);

    if (currentHash === previousHash) {
      return `This matches what I told you the last time you asked about this (${formatRelative(previous.createdAt)}) — nothing in your underlying data has changed since then.`;
    }

    return `Your data has changed since the last time you asked about this (${formatRelative(previous.createdAt)}) — this answer reflects the current numbers, not what you may remember from before.`;
  }

  async recordRun(input: RecordRunInput): Promise<void> {
    await this.prisma.client.agenticCoachRun.create({
      data: {
        userId: input.userId,
        question: input.question,
        path: input.path,
        matchedIntent: input.matchedIntent,
        advancedIntent: input.advancedIntent,
        plan: input.plan,
        facts: input.facts as object,
        citedSources: input.citedSources,
        answer: input.answer,
        confidence: input.confidence,
        verificationPassed: input.verificationPassed,
      },
    });
  }

  async history(userId: string, take = 20) {
    return this.prisma.client.agenticCoachRun.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }
}

function hashFacts(facts: Record<string, unknown>): string {
  // Sorts top-level keys before stringifying so key-insertion-order differences at
  // that level never cause a false "your data changed" result. Not a deep/recursive
  // sort — nested objects (e.g. a gathered report) keep their natural key order, which
  // is fine here because each gatherer method always builds its facts object the same
  // way every time it runs, so nested key order is already deterministic call to call.
  const sorted = JSON.stringify(facts, Object.keys(facts).sort());
  return createHash("sha256").update(sorted).digest("hex");
}

function formatRelative(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "earlier today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return date.toISOString().slice(0, 10);
}
