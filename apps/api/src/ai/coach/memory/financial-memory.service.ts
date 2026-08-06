import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../../prisma/prisma.service";

export interface MemoryConstraint {
  text: string;
  source: "user_stated" | "inferred";
  sourceRunId: string | null;
  createdAt: string;
}

export interface MemoryPreference {
  key: string;
  value: string;
  updatedAt: string;
}

export interface FinancialMemoryProfile {
  constraints: MemoryConstraint[];
  preferences: MemoryPreference[];
  goalNotes: Record<string, string>;
}

const MAX_CONSTRAINTS = 25; // bounded so the memory summary handed to the composer never grows unbounded
const MAX_PREFERENCES = 25;

// --- PERSISTENT FINANCIAL MEMORY ------------------------------------------------------
//
// This is distinct from CoachMemoryService (memory/coach-memory.service.ts), which
// logs and diffs raw per-run facts to detect stale/repeated advice. This service holds
// the DISTILLED, structured cross-session memory every agent consults before
// planning/composing: constraints the user has stated ("don't touch my emergency
// fund"), standing preferences ("prefers avalanche over snowball"), and free-form
// per-goal/plan context. One row per user (CoachFinancialMemory), upserted, never
// unbounded — the oldest entries are trimmed once MAX_CONSTRAINTS/MAX_PREFERENCES is
// exceeded so this always stays a short, prompt-friendly summary rather than an
// ever-growing transcript.
@Injectable()
export class FinancialMemoryService {
  private readonly logger = new Logger(FinancialMemoryService.name);

  constructor(private prisma: PrismaService) {}

  async getOrCreate(userId: string): Promise<FinancialMemoryProfile> {
    const existing = await this.prisma.client.coachFinancialMemory.findUnique({ where: { userId } });
    if (existing) {
      return {
        constraints: (existing.constraints as unknown as MemoryConstraint[]) ?? [],
        preferences: (existing.preferences as unknown as MemoryPreference[]) ?? [],
        goalNotes: (existing.goalNotes as unknown as Record<string, string>) ?? {},
      };
    }

    const created = await this.prisma.client.coachFinancialMemory.create({
      data: { userId, constraints: [], preferences: [], goalNotes: {} },
    });
    return {
      constraints: (created.constraints as unknown as MemoryConstraint[]) ?? [],
      preferences: (created.preferences as unknown as MemoryPreference[]) ?? [],
      goalNotes: (created.goalNotes as unknown as Record<string, string>) ?? {},
    };
  }

  /** Renders the memory profile as a short plain-text block the Planner/Composer
   * agents can drop directly into their prompt input — same "facts, not a black box"
   * philosophy as DataGathererService's factsText. Returns an empty string (not a
   * placeholder sentence) when there's nothing stored yet, so callers can cleanly
   * skip appending an empty section. */
  async summarizeForPrompt(userId: string): Promise<string> {
    const profile = await this.getOrCreate(userId);
    const lines: string[] = [];

    if (profile.constraints.length > 0) {
      lines.push(`Known constraints: ${profile.constraints.map((c) => c.text).join("; ")}.`);
    }
    if (profile.preferences.length > 0) {
      lines.push(`Known preferences: ${profile.preferences.map((p) => `${p.key} = ${p.value}`).join("; ")}.`);
    }
    const noteEntries = Object.entries(profile.goalNotes);
    if (noteEntries.length > 0) {
      lines.push(`Notes: ${noteEntries.map(([k, v]) => `${k} — ${v}`).join("; ")}.`);
    }

    return lines.join("\n");
  }

  /** Adds a constraint if it isn't already present (case-insensitive substring check,
   * not exact match — good enough to avoid obvious duplicates like the user restating
   * the same preference in slightly different words across sessions without needing a
   * semantic-similarity model for what is, in practice, a short list). Oldest entries
   * are dropped once the cap is hit rather than growing forever. */
  async addConstraint(userId: string, text: string, source: "user_stated" | "inferred", sourceRunId: string | null): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    try {
      const profile = await this.getOrCreate(userId);
      const alreadyPresent = profile.constraints.some((c) => c.text.toLowerCase().includes(trimmed.toLowerCase()));
      if (alreadyPresent) return;

      const updated = [
        ...profile.constraints,
        { text: trimmed, source, sourceRunId, createdAt: new Date().toISOString() },
      ].slice(-MAX_CONSTRAINTS);

      await this.prisma.client.coachFinancialMemory.update({
        where: { userId },
        data: { constraints: updated as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      // Financial memory is an enhancement, not a dependency any user-facing answer
      // relies on to be safe/correct — a write failure here must never fail the
      // request that triggered it.
      this.logger.warn(`Failed to persist constraint for user ${userId}: ${(err as Error).message}`);
    }
  }

  async setPreference(userId: string, key: string, value: string): Promise<void> {
    try {
      const profile = await this.getOrCreate(userId);
      const withoutExisting = profile.preferences.filter((p) => p.key !== key);
      const updated = [...withoutExisting, { key, value, updatedAt: new Date().toISOString() }].slice(-MAX_PREFERENCES);

      await this.prisma.client.coachFinancialMemory.update({
        where: { userId },
        data: { preferences: updated as unknown as Prisma.InputJsonValue },
      });
    } catch (err) {
      this.logger.warn(`Failed to persist preference for user ${userId}: ${(err as Error).message}`);
    }
  }

  async setGoalNote(userId: string, key: string, note: string): Promise<void> {
    try {
      const profile = await this.getOrCreate(userId);
      const updated = { ...profile.goalNotes, [key]: note };

      await this.prisma.client.coachFinancialMemory.update({
        where: { userId },
        data: { goalNotes: updated },
      });
    } catch (err) {
      this.logger.warn(`Failed to persist goal note for user ${userId}: ${(err as Error).message}`);
    }
  }
}
