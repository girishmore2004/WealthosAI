import { Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@wealthos/db";
import { PrismaService } from "../../../prisma/prisma.service";
import { FinancialToolsService } from "../../financial-engine/financial-tools.service";
import { FactValue, ToolResult } from "../../financial-engine/financial-types";
import { formatINR } from "../../../common/utils/currency.util";
import { MemoryCryptoService } from "../security/memory-crypto.service";

export type SnapshotFacts = Record<string, Record<string, FactValue>>;

export interface SnapshotPayload {
  asOf: string;
  facts: SnapshotFacts;
  /** Sections whose source failed. Reported, never replaced by a zero. */
  missing: string[];
}

export interface SnapshotChange {
  label: string;
  before: string;
  after: string;
  delta: string;
  direction: "up" | "down" | "flat";
}

export interface SnapshotComparison {
  from: string;
  to: string;
  changes: SnapshotChange[];
}

const SECTIONS: { key: string; label: string }[] = [
  { key: "cashFlow", label: "Monthly cash flow" },
  { key: "netWorth", label: "Net worth" },
  { key: "investments", label: "Investments" },
  { key: "loans", label: "Loans" },
  { key: "emergencyFund", label: "Emergency fund" },
];

// Financial STATE memory: dated snapshots of the user's computed position (income, expenses, savings, investments,
// loans, assets, liabilities, net worth, ratios). Every value comes from the same deterministic tools the dashboard
// uses — never from conversation text — so a snapshot is a verified fact about a date, not something a model said.
@Injectable()
export class FinancialSnapshotService {
  private readonly logger = new Logger(FinancialSnapshotService.name);

  constructor(
    private prisma: PrismaService,
    private tools: FinancialToolsService,
    private crypto: MemoryCryptoService,
  ) {}

  /** One snapshot per user per day (the latest capture of the day wins). Returns null when nothing could be captured or
   * the sensitive-data encryption requirement cannot be met. */
  async capture(userId: string, now: Date = new Date()): Promise<SnapshotPayload | null> {
    if (!this.crypto.isAvailable()) return null;
    const sources: Record<string, () => Promise<ToolResult>> = {
      cashFlow: () => this.tools.getCashFlow(userId),
      netWorth: () => this.tools.getNetWorth(userId),
      investments: () => this.tools.getInvestmentSummary(userId),
      loans: () => this.tools.getLoanSummary(userId),
      emergencyFund: () => this.tools.getEmergencyFundOverview(userId),
    };
    const facts: SnapshotFacts = {};
    const missing: string[] = [];
    await Promise.all(
      Object.entries(sources).map(async ([key, load]) => {
        try {
          const r = await load();
          facts[key] = r.facts;
          for (const m of r.missing) missing.push(`${key}: ${m}`);
        } catch (err) {
          missing.push(`${key}: unavailable`);
          this.logger.warn(`snapshot section ${key} failed: ${(err as Error).name}`);
        }
      }),
    );
    if (Object.keys(facts).length === 0) return null;

    const payload: SnapshotPayload = { asOf: now.toISOString(), facts, missing };
    const snapshotDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const stored = { enc: this.crypto.encrypt(JSON.stringify(payload)) } as unknown as Prisma.InputJsonValue;
    await this.prisma.client.agentMemorySnapshot.upsert({
      where: { userId_snapshotDate: { userId, snapshotDate } },
      create: { userId, snapshotDate, payload: stored },
      update: { payload: stored },
    });
    return payload;
  }

  async list(userId: string, take = 12): Promise<{ date: string; payload: SnapshotPayload }[]> {
    const rows = await this.prisma.client.agentMemorySnapshot.findMany({ where: { userId }, orderBy: { snapshotDate: "desc" }, take: Math.min(take, 60) });
    const out: { date: string; payload: SnapshotPayload }[] = [];
    for (const r of rows) {
      const payload = this.open(r.payload);
      if (payload) out.push({ date: r.snapshotDate.toISOString().slice(0, 10), payload });
    }
    return out;
  }

  /** Latest two snapshots, compared field by field with exact decimal arithmetic. */
  async compareLatest(userId: string): Promise<SnapshotComparison | null> {
    const [latest, previous] = await this.list(userId, 2);
    if (!latest || !previous) return null;
    return compareSnapshots(previous, latest);
  }

  private open(stored: Prisma.JsonValue): SnapshotPayload | null {
    const enc = (stored as { enc?: unknown } | null)?.enc;
    if (typeof enc !== "string") return stored as unknown as SnapshotPayload;
    const text = this.crypto.decrypt(enc);
    if (text === null) return null;
    try {
      return JSON.parse(text) as SnapshotPayload;
    } catch {
      return null;
    }
  }
}

export function compareSnapshots(a: { date: string; payload: SnapshotPayload }, b: { date: string; payload: SnapshotPayload }): SnapshotComparison {
  const changes: SnapshotChange[] = [];
  for (const section of SECTIONS) {
    const before = a.payload.facts[section.key];
    const after = b.payload.facts[section.key];
    if (!before || !after) continue;
    for (const [name, fact] of Object.entries(after)) {
      const prev = before[name];
      if (!prev || prev.kind !== fact.kind) continue;
      let x: Prisma.Decimal, y: Prisma.Decimal;
      try {
        x = new Prisma.Decimal(prev.value);
        y = new Prisma.Decimal(fact.value);
      } catch {
        continue;
      }
      const diff = y.minus(x);
      changes.push({
        label: `${section.label} — ${humanize(name)}`,
        before: formatFact(prev),
        after: formatFact(fact),
        delta: formatFact({ kind: fact.kind, value: diff.toFixed(4) }, true),
        direction: diff.isZero() ? "flat" : diff.greaterThan(0) ? "up" : "down",
      });
    }
  }
  return { from: a.date, to: b.date, changes };
}

export function formatFact(f: FactValue, signed = false): string {
  const n = new Prisma.Decimal(f.value);
  const sign = signed && n.greaterThan(0) ? "+" : "";
  switch (f.kind) {
    case "MONEY":
      return `${sign}${formatINR(n.toNumber())}`;
    case "RATIO":
      return `${sign}${n.times(100).toFixed(1)}%`;
    case "MONTHS":
      return `${sign}${n.toFixed(1)} months`;
    default:
      return `${sign}${n.toFixed(0)}`;
  }
}

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase()).toLowerCase();
}
