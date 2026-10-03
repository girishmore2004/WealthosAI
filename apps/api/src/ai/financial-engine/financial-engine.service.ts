import { Injectable, Logger } from "@nestjs/common";
import { FinancialToolsService } from "./financial-tools.service";
import { routeIntent } from "./financial-intents";
import { composeAnswer, renderRawFacts } from "./answer-composer";
import { verifyAnswer } from "./numeric-verifier";
import {
  FactBasis,
  FactPeriod,
  FinancialIntent,
  HandoffTarget,
  RoutedIntent,
  ToolResult,
  ToolWarning,
  VerificationResult,
} from "./financial-types";

export interface EngineResponse {
  intent: FinancialIntent;
  // true: answered here from authoritative tools. false: deliberately handed off (see `handoff`).
  handled: boolean;
  answer: string | null;
  handoff: { to: HandoffTarget; reason: string } | null;
  tools: Array<{ tool: string; basis: FactBasis; period: FactPeriod; asOfDate: string }>;
  dataHealth: ToolWarning[];
  verification: VerificationResult;
  // true when the composed text failed verification and a plain facts rendering was returned.
  usedFallback: boolean;
}

// Intents the engine does not re-implement. Existing capabilities (document RAG, the legacy
// and agentic coaches, Scenario Studio, general education) are preserved by handing the
// question to them rather than duplicating — and none of them is allowed to invent numbers.
const HANDOFFS: Partial<Record<FinancialIntent, { to: HandoffTarget; reason: string }>> = {
  DOCUMENT_QUERY: { to: "RAG_SEARCH", reason: "Document wording comes from linked documents, not from calculations." },
  TRANSACTION_QUERY: { to: "COACH", reason: "Transaction details come from the transaction services." },
  RETIREMENT: { to: "COACH", reason: "Retirement planning is answered by the retirement service." },
  GOAL: { to: "COACH", reason: "Goal progress is answered by the goals service." },
  TAX: { to: "COACH", reason: "Tax estimates are answered by the tax service." },
  PLANNING: { to: "AGENTIC_COACH", reason: "Multi-step planning is handled by the planning agents." },
  GENERAL_FINANCIAL_EDUCATION: { to: "GENERAL_EDUCATION", reason: "General education is not a statement about your own finances." },
};

// Money-related intents also get the full data-health scan so known inconsistencies are
// mentioned rather than silently ignored.
const HEALTH_INTENTS: FinancialIntent[] = [
  "FINANCIAL_CALCULATION", "FINANCIAL_SUMMARY", "INVESTMENT_ANALYSIS", "EXPENSE_ANALYSIS", "INCOME_ANALYSIS",
  "CASH_FLOW", "NET_WORTH", "EMERGENCY_FUND", "INSURANCE", "SCENARIO",
];

const EMPTY_VERIFICATION: VerificationResult = { passed: true, issues: [] };

@Injectable()
export class FinancialEngineService {
  private readonly logger = new Logger(FinancialEngineService.name);

  constructor(private tools: FinancialToolsService) {}

  // USER QUESTION -> INTENT ROUTER -> TOOLS (authoritative data) -> ANSWER COMPOSER ->
  // NUMERIC VERIFIER -> FINAL ANSWER. `userId` is always the authenticated session's id.
  async ask(userId: string, question: string): Promise<EngineResponse> {
    const routed = routeIntent(question);

    const handoff = HANDOFFS[routed.intent];
    if (handoff) {
      return { intent: routed.intent, handled: false, answer: null, handoff, tools: [], dataHealth: [], verification: EMPTY_VERIFICATION, usedFallback: false };
    }
    if (routed.intent === "SCENARIO" && routed.scenario?.kind === "UNSUPPORTED") {
      return {
        intent: routed.intent, handled: false, answer: null, tools: [], dataHealth: [], verification: EMPTY_VERIFICATION, usedFallback: false,
        handoff: { to: "SCENARIO_STUDIO", reason: "This scenario type is modelled by Scenario Studio." },
      };
    }

    const results = await this.runTools(userId, routed);

    let answer = composeAnswer(routed, results);
    let verification = verifyAnswer(answer, results);
    let usedFallback = false;
    if (!verification.passed) {
      // The composer is deterministic, so a failure means a bug or inconsistent facts. Never
      // return an unverified figure: log the issue codes (no amounts) and fall back.
      this.logger.warn(`Numeric verification failed (${verification.issues.map((i) => i.code).join(",")}) for intent ${routed.intent}`);
      answer = `I couldn't present this reliably, so here are the raw figures from your records:\n${renderRawFacts(results)}`;
      verification = verifyAnswer(answer, results);
      usedFallback = true;
    }

    return {
      intent: routed.intent,
      handled: true,
      answer,
      handoff: null,
      tools: results.map((t) => ({ tool: t.tool, basis: t.basis, period: t.period, asOfDate: t.asOfDate })),
      dataHealth: dedupeWarnings(results),
      verification,
      usedFallback,
    };
  }

  private async runTools(userId: string, routed: RoutedIntent): Promise<ToolResult[]> {
    const t = this.tools;
    let core: ToolResult[] = [];
    switch (routed.intent) {
      case "FINANCIAL_CALCULATION":
      case "EXPENSE_ANALYSIS":
      case "INCOME_ANALYSIS":
        core = [await t.getCashFlow(userId)];
        break;
      case "NET_WORTH":
        core = [await t.getNetWorth(userId)];
        break;
      case "CASH_FLOW":
      case "FINANCIAL_SUMMARY":
        core = await t.getFinancialFacts(userId);
        break;
      case "EMERGENCY_FUND":
        core = [await t.calculateEmergencyCoverage(userId)];
        break;
      case "INVESTMENT_ANALYSIS":
        core = [await t.getInvestmentSummary(userId)];
        break;
      case "INSURANCE":
        core = [await t.getInsuranceSummary(userId)];
        break;
      case "LOAN":
        core = [await t.getLoanSummary(userId)];
        break;
      case "SCENARIO": {
        const sc = routed.scenario ? await t.calculateScenario(userId, routed.scenario) : null;
        core = sc ? [sc] : [];
        break;
      }
      default:
        core = [];
    }

    if (!HEALTH_INTENTS.includes(routed.intent) || core.length === 0) return core;
    try {
      return [...core, await t.getDataHealth(userId)];
    } catch (err) {
      // Not swallowed silently: the answer says the check could not run.
      this.logger.error(`Data health scan failed: ${(err as Error).name}`);
      return [...core, { tool: "getDataHealth", basis: "ACTUAL", period: "CUSTOM", asOfDate: new Date().toISOString(), facts: {}, warnings: [], missing: ["the data-health check (it could not run)"] }];
    }
  }
}

function dedupeWarnings(results: ToolResult[]): ToolWarning[] {
  const seen = new Map<string, ToolWarning>();
  for (const r of results) for (const w of r.warnings) if (w.code !== "SCENARIO_NOTE" && !seen.has(w.code)) seen.set(w.code, w);
  return [...seen.values()];
}
