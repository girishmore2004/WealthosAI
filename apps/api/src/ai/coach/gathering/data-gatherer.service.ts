import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { GoalsService } from "../../../goals/goals.service";
import { DashboardService } from "../../../dashboard/dashboard.service";
import { AlertsService } from "../../../alerts/alerts.service";
import { LoansService } from "../../../loans/loans.service";
import { InvestmentsService } from "../../../investments/investments.service";
import { RetirementService } from "../../../retirement/retirement.service";
import { ReportsService } from "../../../reports/reports.service";
import { RagService, RagSearchResult } from "../../rag/rag.service";
import { AiGatewayService } from "../../gateway/ai-gateway.service";
import { FeatureExtractionService } from "../../ml-insights/features/feature-extraction.service";
import { DriftDetectionModel } from "../../ml-insights/models/drift-detection.model";
import { formatINR } from "../../../common/utils/currency.util";
import { AdvancedCoachIntent } from "../coach2.constants";

export interface GatheredEvidence {
  /** Plain-text rendering of every fact gathered — this is both what the composer is
   * told it may draw numbers from AND what NumericConsistencyVerifier checks the
   * composed answer against. If a number isn't in here, the composer isn't allowed to
   * say it. */
  factsText: string;
  /** Structured version of the same facts, stored on AgenticCoachRun for the
   * frontend's expandable evidence section — human-browsable, not just a blob. */
  facts: Record<string, unknown>;
  citedSources: string[];
  ragResult?: RagSearchResult;
}

const periodParseSchema = z.object({
  periodA: z.string().describe("YYYY-MM format"),
  periodB: z.string().describe("YYYY-MM format"),
});

@Injectable()
export class DataGathererService {
  private readonly logger = new Logger(DataGathererService.name);

  constructor(
    private goals: GoalsService,
    private dashboard: DashboardService,
    private alerts: AlertsService,
    private loans: LoansService,
    private investments: InvestmentsService,
    private retirement: RetirementService,
    private reports: ReportsService,
    private rag: RagService,
    private gateway: AiGatewayService,
    private features: FeatureExtractionService,
    private driftModel: DriftDetectionModel,
  ) {}

  async gather(userId: string, intent: AdvancedCoachIntent, question: string): Promise<GatheredEvidence> {
    switch (intent) {
      case "prioritize_actions":
        return this.gatherPrioritizeActions(userId);
      case "goal_conflict":
        return this.gatherGoalConflict(userId);
      case "risk_tradeoff":
        return this.gatherRiskTradeoff(userId);
      case "compare_periods":
        return this.gatherComparePeriods(userId, question);
      case "general_search":
        return this.gatherGeneralSearch(userId, question);
    }
  }

  private async gatherPrioritizeActions(userId: string): Promise<GatheredEvidence> {
    const [alerts, goals] = await Promise.all([this.alerts.list(userId, false), this.goals.list(userId)]);

    const items = [
      ...alerts.map((a) => `Alert (${a.severity}): "${a.title}" — ${a.message}`),
      ...goals
        .filter((g) => g.probabilityOfSuccess !== "ON_TRACK")
        .map((g) => `Goal "${g.name}" is ${g.probabilityOfSuccess.replace("_", " ").toLowerCase()}, ${g.progressPercent}% funded, needs ${formatINR(g.requiredMonthlyContribution)}/month.`),
    ];

    if (items.length === 0) {
      return {
        factsText: "No open alerts and all goals are on track — there is nothing that needs prioritizing right now.",
        facts: { alerts: [], goals: [] },
        citedSources: [],
      };
    }

    let orderedItems = items;
    try {
      const ranked = await this.gateway.rank(items, "most urgent to address first", {
        feature: "coach2.prioritize",
        promptName: "coach2.prioritize",
        userId,
        cacheable: false,
      });
      orderedItems = ranked.data.orderedIndices.filter((i) => i < items.length).map((i) => items[i]);
      if (orderedItems.length === 0) orderedItems = items;
    } catch (err) {
      this.logger.warn(`Prioritization ranking unavailable, using original order: ${(err as Error).message}`);
    }

    return {
      factsText: `Open items, in priority order:\n${orderedItems.map((item, i) => `${i + 1}. ${item}`).join("\n")}`,
      facts: { items: orderedItems },
      citedSources: [],
    };
  }

  private async gatherGoalConflict(userId: string): Promise<GatheredEvidence> {
    const [summary, debtSummary, goals] = await Promise.all([
      this.dashboard.getSummary(userId),
      this.loans.debtSummary(userId),
      this.goals.list(userId),
    ]);

    const monthlyIncome = Number(summary.monthlyIncome);
    const monthlyExpenses = Number(summary.monthlyExpenses);
    const totalMonthlyEmi = Number(debtSummary.totalMonthlyEmi);
    const surplus = monthlyIncome - monthlyExpenses - totalMonthlyEmi;

    const committedContributions = goals.reduce((sum, g) => sum + Number(g.monthlyContribution), 0);
    const requiredContributions = goals.reduce((sum, g) => sum + g.requiredMonthlyContribution, 0);

    const overcommitted = committedContributions > surplus;
    const targetsUnreachable = requiredContributions > surplus;

    const factsText =
      `Monthly income: ${formatINR(monthlyIncome)}. Monthly expenses: ${formatINR(monthlyExpenses)}. ` +
      `Monthly loan EMIs: ${formatINR(totalMonthlyEmi)}. Available monthly surplus: ${formatINR(surplus)}.\n` +
      `${goals.length} goal(s) with a total committed contribution of ${formatINR(committedContributions)}/month, ` +
      `and a total required contribution (to hit all targets on time) of ${formatINR(requiredContributions)}/month.\n` +
      `Overcommitted (committed contributions exceed surplus): ${overcommitted ? "yes" : "no"}. ` +
      `Targets unreachable at current surplus (required contributions exceed surplus): ${targetsUnreachable ? "yes" : "no"}.`;

    return {
      factsText,
      facts: { monthlyIncome, monthlyExpenses, totalMonthlyEmi, surplus, committedContributions, requiredContributions, overcommitted, targetsUnreachable, goalCount: goals.length },
      citedSources: [],
    };
  }

  private async gatherRiskTradeoff(userId: string): Promise<GatheredEvidence> {
    const [investmentSummary, debtSummary, retirementProfile] = await Promise.all([
      this.investments.summary(userId),
      this.loans.debtSummary(userId),
      this.retirement.getOrCreateProfile(userId),
    ]);

    const highestRateLoan = [...debtSummary.loans].sort((a, b) => Number(b.interestRateAnnual) - Number(a.interestRateAnnual))[0];
    const expectedReturn = Number(retirementProfile.expectedReturnPreRetirementPercent);

    const debtVsInvestNote = highestRateLoan
      ? `Your highest-interest loan (${highestRateLoan.lender}, ${highestRateLoan.type.toLowerCase()}) charges ${highestRateLoan.interestRateAnnual}% annually, ` +
        `versus your own stated expected investment return of ${expectedReturn}%. ${
          Number(highestRateLoan.interestRateAnnual) > expectedReturn
            ? "The loan rate is higher than your expected return, so prepaying it is the mathematically safer use of extra money."
            : "Your expected return is higher than the loan rate, so continuing to invest extra money mathematically edges out prepaying — though a loan is guaranteed and an investment return is not."
        }`
      : "You have no loans logged, so there's no debt-vs-invest tradeoff to weigh — extra money can go entirely toward investing per your risk profile.";

    const factsText =
      `Total investment value: ${investmentSummary.totalCurrentValue}, ${investmentSummary.totalGainLossPercent}% gain/loss from cost basis. ` +
      `Largest allocation: ${investmentSummary.allocation[0] ? `${investmentSummary.allocation[0].type} at ${investmentSummary.allocation[0].percent}%` : "none"}.\n` +
      `Total debt outstanding: ${debtSummary.totalOutstanding}, debt stress score ${debtSummary.debtStressScore}%.\n` +
      debtVsInvestNote;

    return {
      factsText,
      facts: {
        totalCurrentValue: investmentSummary.totalCurrentValue,
        totalGainLossPercent: investmentSummary.totalGainLossPercent,
        totalOutstanding: debtSummary.totalOutstanding,
        debtStressScore: debtSummary.debtStressScore,
        highestRateLoan: highestRateLoan ? { lender: highestRateLoan.lender, rate: highestRateLoan.interestRateAnnual } : null,
        expectedReturn,
      },
      citedSources: [],
    };
  }

  private async gatherComparePeriods(userId: string, question: string): Promise<GatheredEvidence> {
    const now = new Date();
    const defaultA = now.toISOString().slice(0, 7);
    const previous = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const defaultB = previous.toISOString().slice(0, 7);

    let periodA = defaultA;
    let periodB = defaultB;
    try {
      const parsed = await this.gateway.extract(
        `Today's date is ${now.toISOString().slice(0, 10)}. Question: "${question}". If the question doesn't clearly name two periods, default periodA to ${defaultA} (this month) and periodB to ${defaultB} (last month).`,
        periodParseSchema,
        { feature: "coach2.compare_periods.parse", promptName: "coach2.compare_periods_parse", userId, cacheable: false },
      );
      periodA = parsed.data.periodA;
      periodB = parsed.data.periodB;
    } catch (err) {
      this.logger.warn(`Period parsing unavailable, defaulting to this month vs last month: ${(err as Error).message}`);
    }

    const [reportA, reportB] = await Promise.all([
      this.reports.monthlyReport(userId, periodA),
      this.reports.monthlyReport(userId, periodB),
    ]);

    const incomeDiff = Number(reportA.income) - Number(reportB.income);
    const expenseDiff = Number(reportA.expenses) - Number(reportB.expenses);
    const savingsRateDiff = Number((reportA.savingsRate - reportB.savingsRate).toFixed(1));

    // Phase 14 integration point: augment the two-report comparison (which only ever
    // looks at exactly the two named periods) with a statistical read on whether the
    // broader recent trend is a genuine, significant shift or just normal month-to-
    // month noise — a two-window z-test over more months than just A and B. This is
    // the concrete instance of "Coach uses ML outputs when explaining why this
    // changed" from the roadmap; it augments the deterministic report diff above, it
    // never replaces it as the source of the actual numbers.
    let driftNote = "";
    try {
      const monthlySeries = await this.features.monthlySeries(userId);
      const drift = this.driftModel.detect(monthlySeries);
      if (drift.prediction.drifted) {
        driftNote = ` Separately, a statistical trend check (${drift.method}) finds your savings rate has ${drift.prediction.direction === "improving" ? "significantly improved" : "significantly worsened"} over a broader recent window, not just between these two specific months (confidence ${Math.round(drift.confidence * 100)}%).`;
      }
    } catch (err) {
      this.logger.warn(`ML drift check unavailable for compare_periods: ${(err as Error).message}`);
    }

    const factsText =
      `${periodA}: income ${formatINR(reportA.income)}, expenses ${formatINR(reportA.expenses)}, savings rate ${reportA.savingsRate}%.\n` +
      `${periodB}: income ${formatINR(reportB.income)}, expenses ${formatINR(reportB.expenses)}, savings rate ${reportB.savingsRate}%.\n` +
      `Change from ${periodB} to ${periodA}: income ${incomeDiff >= 0 ? "up" : "down"} ${formatINR(Math.abs(incomeDiff))}, ` +
      `expenses ${expenseDiff >= 0 ? "up" : "down"} ${formatINR(Math.abs(expenseDiff))}, ` +
      `savings rate ${savingsRateDiff >= 0 ? "up" : "down"} ${Math.abs(savingsRateDiff)} percentage points.${driftNote}`;

    return {
      factsText,
      facts: { periodA, periodB, reportA, reportB, incomeDiff, expenseDiff, savingsRateDiff, driftNote: driftNote || null },
      citedSources: [],
    };
  }

  private async gatherGeneralSearch(userId: string, question: string): Promise<GatheredEvidence> {
    const ragResult = await this.rag.search(userId, question);
    return {
      factsText: ragResult.hasEvidence
        ? `Found evidence: ${ragResult.answer}\n\nSources:\n${ragResult.citedSources.map((s) => `- (${s.sourceType}) ${s.title}: ${s.snippet}`).join("\n")}`
        : "No matching evidence was found in the user's documents, reports, coach history, or alerts.",
      facts: { hasEvidence: ragResult.hasEvidence, citedSourceCount: ragResult.citedSources.length },
      citedSources: ragResult.citedSources.map((s) => s.chunkId),
      ragResult,
    };
  }
}
