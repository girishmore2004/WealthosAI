import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GoalsService } from "../goals/goals.service";
import { TaxService } from "../tax/tax.service";
import { RetirementService } from "../retirement/retirement.service";
import { InsuranceService } from "../insurance/insurance.service";
import { InvestmentsService } from "../investments/investments.service";
import { ExpensesService } from "../expenses/expenses.service";
import { LoansService } from "../loans/loans.service";
import { IncomeService } from "../income/income.service";
import { DashboardService } from "../dashboard/dashboard.service";
import { AlertsService } from "../alerts/alerts.service";
import { currentFinancialYear } from "../common/utils/financial-year.util";
import { matchIntent, COACH_INTENTS } from "./coach.intents";
import { CoachInteractionDTO } from "@wealthos/types";
import { formatINR } from "../common/utils/currency.util";

interface GroundedAnswer {
  answer: string;
  dataSources: string[];
  insufficientData?: boolean; // matched a real intent, but the DB doesn't have enough to answer it
}

// The AI Coach is NOT an LLM — it's a deterministic router: match a question to one of
// a fixed set of intents, then answer using ONLY the corresponding existing service's
// live data for that user. There is no free-text generation and no external API call,
// so every sentence in every answer traces back to a specific number from a specific
// service. Unmatched questions are refused rather than guessed at.
@Injectable()
export class CoachService {
  constructor(
    private prisma: PrismaService,
    private goalsService: GoalsService,
    private taxService: TaxService,
    private retirementService: RetirementService,
    private insuranceService: InsuranceService,
    private investmentsService: InvestmentsService,
    private expensesService: ExpensesService,
    private loansService: LoansService,
    private incomeService: IncomeService,
    private dashboardService: DashboardService,
    private alertsService: AlertsService,
  ) {}

  async ask(userId: string, question: string): Promise<CoachInteractionDTO> {
    const intent = matchIntent(question);

    const grounded: GroundedAnswer = intent
      ? await this.dispatch(userId, intent.id)
      : {
          answer: `I can only answer from the data already in your account. I can help with: ${COACH_INTENTS.map((i) => i.topicLabel).join(", ")}. Try rephrasing your question around one of those.`,
          dataSources: [],
        };

    const interaction = await this.prisma.client.coachInteraction.create({
      data: {
        userId,
        question,
        matchedIntent: intent?.id ?? null,
        answer: grounded.answer,
        dataSources: grounded.dataSources,
        wasRefused: intent === null || grounded.insufficientData === true,
      },
    });

    return { ...interaction, createdAt: this.toIsoString(interaction.createdAt) };
  }

  async history(userId: string, take = 20): Promise<CoachInteractionDTO[]> {
    const interactions = await this.prisma.client.coachInteraction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });

    return interactions.map((interaction) => ({
      ...interaction,
      createdAt: this.toIsoString(interaction.createdAt),
    }));
  }

  private toIsoString(value: Date | string | undefined): string {
    return value ? new Date(value).toISOString() : new Date().toISOString();
  }

  private async dispatch(userId: string, intentId: string): Promise<GroundedAnswer> {
    switch (intentId) {
      case "SUMMARY":
        return this.answerSummary(userId);
      case "NEXT_ACTION":
        return this.answerNextAction(userId);
      case "WHY_CHANGED":
        return this.answerWhyChanged(userId);
      case "RISK":
        return this.answerRisk(userId);
      case "NET_WORTH":
        return this.answerNetWorth(userId);
      case "SAVINGS_RATE":
        return this.answerSavingsRate(userId);
      case "DEBT":
        return this.answerDebt(userId);
      case "GOALS":
        return this.answerGoals(userId);
      case "TAX":
        return this.answerTax(userId);
      case "RETIREMENT":
        return this.answerRetirement(userId);
      case "INSURANCE":
        return this.answerInsurance(userId);
      case "INVESTMENTS":
        return this.answerInvestments(userId);
      case "SPENDING":
        return this.answerSpending(userId);
      case "SUBSCRIPTIONS":
        return this.answerSubscriptions(userId);
      default:
        // Defensive fallback — should be unreachable since dispatch is only called
        // with an id that just came from COACH_INTENTS, but never silently guesses.
        return { answer: "I recognized the topic but don't have a grounded answer wired up for it yet.", dataSources: [] };
    }
  }

  private async answerSummary(userId: string): Promise<GroundedAnswer> {
    const summary = await this.dashboardService.getSummary(userId);
    return {
      answer: `Net worth is ${formatINR(summary.netWorth)} (${formatINR(summary.investmentsValue)} invested, ${formatINR(summary.totalDebt)} in debt). This month's savings rate is ${summary.savingsRate}%. Financial health score: ${summary.healthScore.score}/100 (${summary.healthScore.band.replace("_", " ").toLowerCase()}). You have ${summary.unreadAlertCount} unread alert(s).`,
      dataSources: ["dashboard", "alerts"],
    };
  }

  private async answerNextAction(userId: string): Promise<GroundedAnswer> {
    const alerts = await this.alertsService.list(userId, true);
    if (alerts.length === 0) {
      return { answer: "No open alerts right now — nothing urgent is flagged from your current data.", dataSources: ["alerts"] };
    }
    const top = [...alerts].sort((a, b) => {
      const order = { CRITICAL: 0, WARNING: 1, INFO: 2 };
      return order[a.severity] - order[b.severity];
    })[0];
    return {
      answer: `Highest-priority open item: "${top.title}" — ${top.message}`,
      dataSources: ["alerts"],
    };
  }

  private async answerWhyChanged(userId: string): Promise<GroundedAnswer> {
    // Honest "insufficient data" case: this app doesn't yet persist periodic net-worth
    // or category-spend snapshots, so there's no stored "before" state to diff against
    // a "why did X change" question — answering anyway would mean guessing, not
    // grounding. The intent is still recorded as matched (not a generic refusal) since
    // the question WAS understood; it just can't be answered from what's in the DB yet.
    const recentAlerts = await this.alertsService.list(userId, false);
    if (recentAlerts.length > 0) {
      return {
        answer: `I don't store historical snapshots yet, so I can't explain a specific change over time. What I can tell you is what's currently flagged: ${recentAlerts.slice(0, 3).map((a) => a.title).join("; ")}. Check Reports for month-over-month figures.`,
        dataSources: ["alerts"],
        insufficientData: true,
      };
    }
    return {
      answer: "I don't have enough historical data stored to explain a change over time yet — this would need periodic net-worth/spending snapshots, which aren't tracked yet. Try the Reports page for point-in-time monthly and yearly figures instead.",
      dataSources: [],
      insufficientData: true,
    };
  }

  private async answerRisk(userId: string): Promise<GroundedAnswer> {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    const [investmentSummary, debtSummary] = await Promise.all([
      this.investmentsService.summary(userId),
      this.loansService.debtSummary(userId),
    ]);
    if (!user) {
      return { answer: "I couldn't find your profile.", dataSources: [], insufficientData: true };
    }
    const concentrationNote =
      investmentSummary.allocation.length > 0 && investmentSummary.allocation[0].percent > 60
        ? ` Your portfolio is concentrated: ${investmentSummary.allocation[0].percent}% is in ${investmentSummary.allocation[0].type.toLowerCase()} alone.`
        : "";
    return {
      answer: `Your declared risk profile is ${user.riskProfile.toLowerCase()}. Current debt-to-income stress score is ${debtSummary.debtStressScore}%.${concentrationNote}`,
      dataSources: ["profile", "investments", "loans"],
    };
  }

  private async answerNetWorth(userId: string): Promise<GroundedAnswer> {
    const [investmentsValue, totalDebt, incomes, expenses] = await Promise.all([
      this.investmentsService.totalCurrentValue(userId),
      this.loansService.totalOutstanding(userId),
      this.incomeService.list(userId),
      this.expensesService.list(userId),
    ]);
    const cash = incomes.reduce((s, i) => s + Number(i.amount), 0) - expenses.reduce((s, e) => s + Number(e.amount), 0);
    const netWorth = cash + investmentsValue - totalDebt;
    return {
      answer: `Your net worth is approximately ${formatINR(netWorth)} — that's ${formatINR(cash)} in cash flow, ${formatINR(investmentsValue)} in investments, minus ${formatINR(totalDebt)} in outstanding debt. This doesn't yet include property value if you've added properties separately.`,
      dataSources: ["income", "expenses", "investments", "loans"],
    };
  }

  private async answerSavingsRate(userId: string): Promise<GroundedAnswer> {
    const monthlyIncome = await this.incomeService.monthlyForecast(userId);
    const currentMonth = new Date().toISOString().slice(0, 7);
    const monthExpenses = await this.expensesService.list(userId, currentMonth);
    const spent = monthExpenses.reduce((s, e) => s + Number(e.amount), 0);
    if (monthlyIncome <= 0) {
      return { answer: "I can't compute a savings rate yet — no income has been logged.", dataSources: ["income"] };
    }
    const rate = Math.max(0, ((monthlyIncome - spent) / monthlyIncome) * 100);
    return {
      answer: `This month's savings rate is about ${rate.toFixed(1)}%, based on ${formatINR(monthlyIncome)} in forecast monthly income and ${formatINR(spent)} spent so far.`,
      dataSources: ["income", "expenses"],
    };
  }

  private async answerDebt(userId: string): Promise<GroundedAnswer> {
    const summary = await this.loansService.debtSummary(userId);
    if (summary.loans.length === 0) {
      return { answer: "You don't have any loans logged, so there's no EMI burden to report.", dataSources: ["loans"] };
    }
    return {
      answer: `You have ${summary.loans.length} loan(s) totaling ${formatINR(summary.totalOutstanding)} outstanding, with monthly EMIs of ${formatINR(summary.totalMonthlyEmi)}. That's ${summary.debtStressScore}% of your monthly income.`,
      dataSources: ["loans", "income"],
    };
  }

  private async answerGoals(userId: string): Promise<GroundedAnswer> {
    const goals = await this.goalsService.list(userId);
    if (goals.length === 0) {
      return { answer: "You haven't set any financial goals yet.", dataSources: ["goals"] };
    }
    const offTrack = goals.filter((g) => g.probabilityOfSuccess === "OFF_TRACK");
    const lines = goals.map((g) => `"${g.name}" is ${g.progressPercent}% funded and ${g.probabilityOfSuccess.replace("_", " ").toLowerCase()}`);
    const summary = offTrack.length > 0 ? ` ${offTrack.length} of them may miss their target date at the current contribution rate.` : " All are on track or close to it.";
    return { answer: `You have ${goals.length} goal(s): ${lines.join("; ")}.${summary}`, dataSources: ["goals"] };
  }

  private async answerTax(userId: string): Promise<GroundedAnswer> {
    const estimate = await this.taxService.estimate(userId, currentFinancialYear());
    return {
      answer: `For FY ${estimate.financialYear}, the ${estimate.recommendedRegime.toLowerCase()} regime looks better by ${formatINR(estimate.savingsFromRecommendedRegime)}, based on income and deductions logged so far. This is a simplified educational estimate, not tax advice.`,
      dataSources: ["tax", "income"],
    };
  }

  private async answerRetirement(userId: string): Promise<GroundedAnswer> {
    const plan = await this.retirementService.computePlan(userId);
    return {
      answer: plan.onTrack
        ? `You're projected to reach your retirement corpus target of ${formatINR(plan.corpusRequired)} in ${plan.yearsToRetirement} years at the current contribution rate.`
        : `There's a projected gap of ${formatINR(plan.corpusGap)} against your ${formatINR(plan.corpusRequired)} target in ${plan.yearsToRetirement} years. Closing it would need roughly ${formatINR(plan.requiredMonthlySip)}/month more invested.`,
      dataSources: ["retirement", "investments"],
    };
  }

  private async answerInsurance(userId: string): Promise<GroundedAnswer> {
    const gaps = await this.insuranceService.gapAnalysis(userId);
    const uncovered = gaps.filter((g) => !g.hasCoverage || Number(g.gap) > 0);
    if (uncovered.length === 0) {
      return { answer: "Your logged coverage meets the rule-of-thumb benchmarks I check against.", dataSources: ["insurance"] };
    }
    return {
      answer: `Potential coverage gaps: ${uncovered.map((g) => `${g.type.toLowerCase()} (${g.message})`).join("; ")}. These are rule-of-thumb benchmarks, not personalized advice.`,
      dataSources: ["insurance"],
    };
  }

  private async answerInvestments(userId: string): Promise<GroundedAnswer> {
    const summary = await this.investmentsService.summary(userId);
    if (Number(summary.totalCurrentValue) === 0) {
      return { answer: "No investments logged yet.", dataSources: ["investments"] };
    }
    const top = summary.allocation[0];
    return {
      answer: `Your portfolio is worth ${formatINR(summary.totalCurrentValue)}, ${summary.totalGainLossPercent >= 0 ? "up" : "down"} ${Math.abs(summary.totalGainLossPercent)}% from cost basis. Largest allocation: ${top ? `${top.type.toLowerCase()} at ${top.percent}%` : "none"}.`,
      dataSources: ["investments"],
    };
  }

  private async answerSpending(userId: string): Promise<GroundedAnswer> {
    const breakdown = await this.expensesService.categoryBreakdown(userId);
    if (breakdown.length === 0) {
      return { answer: "No expenses logged this month yet.", dataSources: ["expenses"] };
    }
    const top3 = breakdown.slice(0, 3);
    return {
      answer: `This month's top spending categories: ${top3.map((c) => `${c.name} (${formatINR(c.total)})`).join(", ")}.`,
      dataSources: ["expenses"],
    };
  }

  private async answerSubscriptions(userId: string): Promise<GroundedAnswer> {
    const subs = await this.expensesService.detectSubscriptions(userId);
    if (subs.length === 0) {
      return { answer: "No recurring subscriptions detected from your recent expenses.", dataSources: ["expenses"] };
    }
    return {
      answer: `Detected ${subs.length} recurring charge(s): ${subs.map((s) => `${s.merchant} (~${formatINR(s.averageAmount)}/mo)`).join(", ")}.`,
      dataSources: ["expenses"],
    };
  }
}
