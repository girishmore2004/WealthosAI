import { Injectable, Logger } from "@nestjs/common";
import { z } from "zod";
import { CoachService } from "../../coach/coach.service";
import { IntentClassifierService } from "./planning/intent-classifier.service";
import { PlannerService } from "./planning/planner.service";
import { DataGathererService } from "./gathering/data-gatherer.service";
import { AnswerComposerService } from "./composition/answer-composer.service";
import { VerifierAgentService, PlanConsistencyContext } from "./verification/verifier-agent.service";
import { CriticAgentService } from "./verification/critic-agent.service";
import { CoachMemoryService } from "./memory/coach-memory.service";
import { FinancialMemoryService } from "./memory/financial-memory.service";
import { FinanceCalculatorService } from "./calculation/finance-calculator.service";
import { FinancialPlanAgentService } from "./planning/financial-plan-agent.service";
import { TaskAgentService } from "./execution/task-agent.service";
import { PlanMonitorService } from "./plans/plan-monitor.service";
import { AiGatewayService } from "../gateway/ai-gateway.service";
import { AiUnavailableException, AiValidationException } from "../exceptions/ai.exceptions";
import { formatINR } from "../../common/utils/currency.util";
import { CoachPlanType } from "@wealthos/db";

export interface AgenticCoachResult {
  question: string;
  path: "DETERMINISTIC" | "ADVANCED";
  matchedIntent: string | null;
  advancedIntent: string | null;
  plan: string[];
  facts: Record<string, unknown>;
  citedSources: string[];
  answer: string;
  confidence: number;
  verificationPassed: boolean;
  staleAdviceNote: string | null;
  // --- Phase 20 additions — additive to the API response, never required by an
  // existing consumer that doesn't read them.
  planId: string | null;
  criticFlags: string[];
  createdTaskIds: string[];
}

const FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE = 0.5;

const planRequestSchema = z.object({
  type: z.enum(["DEBT_PAYOFF", "SAVINGS_TARGET", "RETIREMENT", "INVESTMENT_ALLOCATION", "CUSTOM"]),
  title: z.string(),
  targetAmount: z.number().optional().describe("Only if the user stated a concrete target amount"),
  months: z.number().optional().describe("Only if the user stated a concrete timeline in months (convert years to months)"),
  loanNameHint: z.string().optional().describe("Free text the user used to refer to a specific loan, if type is DEBT_PAYOFF"),
  goalNameHint: z.string().optional().describe("Free text the user used to refer to an existing goal, if any"),
});

@Injectable()
export class AgenticCoachService {
  private readonly logger = new Logger(AgenticCoachService.name);

  constructor(
    private coach: CoachService,
    private classifier: IntentClassifierService,
    private planner: PlannerService,
    private gatherer: DataGathererService,
    private composer: AnswerComposerService,
    private verifierAgent: VerifierAgentService,
    private critic: CriticAgentService,
    private memory: CoachMemoryService,
    private financialMemory: FinancialMemoryService,
    private calculator: FinanceCalculatorService,
    private planAgent: FinancialPlanAgentService,
    private taskAgent: TaskAgentService,
    private planMonitor: PlanMonitorService,
    private gateway: AiGatewayService,
  ) {}

  async ask(userId: string, question: string): Promise<AgenticCoachResult> {
    const classification = await this.classifier.classify(userId, question);
    const plan = this.planner.buildPlan(classification);

    const result =
      classification.path === "deterministic"
        ? await this.runDeterministicPath(userId, question, classification.intent.id, plan.steps.map((s) => s.description))
        : await this.runAdvancedPath(userId, question, classification.intent, plan);

    const staleAdviceNote = await this.memory.checkForStaleOrRepeatedAdvice(
      userId,
      { matchedIntent: result.matchedIntent, advancedIntent: result.advancedIntent },
      result.facts,
    );

    await this.memory.recordRun({
      userId,
      question,
      path: result.path,
      matchedIntent: result.matchedIntent,
      advancedIntent: result.advancedIntent,
      plan: result.plan,
      facts: result.facts,
      citedSources: result.citedSources,
      answer: result.answer,
      confidence: result.confidence,
      verificationPassed: result.verificationPassed,
      staleAdviceNote,
      criticFlags: result.criticFlags,
      createdTaskIds: result.createdTaskIds,
      planId: result.planId,
    });

    return { ...result, staleAdviceNote };
  }

  async history(userId: string, take = 20) {
    return this.memory.history(userId, take);
  }

  // --- DETERMINISTIC PATH (unchanged behavior, Critic screening added) ---------------

  private async runDeterministicPath(
    userId: string,
    question: string,
    matchedIntent: string,
    planSteps: string[],
  ): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const v1Interaction = await this.coach.ask(userId, question);
    const facts = { baseAnswer: v1Interaction.answer, dataSources: v1Interaction.dataSources };
    const factsText = `${v1Interaction.answer}\n(Grounded in: ${v1Interaction.dataSources.join(", ") || "none"})`;

    const base = {
      question,
      path: "DETERMINISTIC" as const,
      matchedIntent,
      advancedIntent: null,
      facts,
      citedSources: [],
      planId: null,
      createdTaskIds: [],
    };

    try {
      const composed = await this.composer.compose(userId, question, factsText, "coach2.explain_deterministic");
      // Verification is not applicable here (the base answer is already
      // code-grounded) — but the Critic Agent still screens the composed color-text
      // itself, since composition can introduce over-promising language even over an
      // already-correct answer.
      const critique = await this.criticOnly(userId, composed.answer);

      if (critique.severity === "none") {
        return {
          ...base,
          plan: planSteps,
          answer: composed.answer,
          confidence: composed.confidence,
          verificationPassed: true,
          criticFlags: [],
        };
      }

      this.logger.warn(`Deterministic-path composition flagged by Critic Agent (${critique.flags.join(", ")}) — using base answer verbatim.`);
      return {
        ...base,
        plan: [...planSteps, `Critic Agent flagged the composed color-text (${critique.flags.join(", ")}) — returned the base deterministic answer unmodified.`],
        answer: v1Interaction.answer,
        confidence: 1,
        verificationPassed: true,
        criticFlags: critique.flags,
      };
    } catch (err) {
      this.logger.warn(`Deterministic-path composition unavailable, using base answer verbatim: ${(err as Error).message}`);
      return {
        ...base,
        plan: [...planSteps, "Composition was unavailable — returned the base deterministic answer unmodified."],
        answer: v1Interaction.answer,
        confidence: 1,
        verificationPassed: true,
        criticFlags: [],
      };
    }
  }

  // --- ADVANCED PATH dispatcher --------------------------------------------------------

  private async runAdvancedPath(
    userId: string,
    question: string,
    advancedIntent:
      | "prioritize_actions"
      | "goal_conflict"
      | "risk_tradeoff"
      | "compare_periods"
      | "create_plan"
      | "plan_progress_check"
      | "calculation_request"
      | "general_search",
    plan: { steps: { description: string }[]; needsComposition: boolean; needsVerification: boolean },
  ): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const planSteps = plan.steps.map((s) => s.description);

    if (advancedIntent === "create_plan") {
      return this.runCreatePlan(userId, question, planSteps);
    }
    if (advancedIntent === "plan_progress_check") {
      return this.runPlanProgressCheck(userId, question, planSteps);
    }
    if (advancedIntent === "calculation_request") {
      return this.runCalculationRequest(userId, question, planSteps);
    }

    return this.runLegacyAdvancedPath(userId, question, advancedIntent, plan, planSteps);
  }

  // --- Legacy advanced intents (prioritize_actions / goal_conflict / risk_tradeoff /
  // compare_periods / general_search) — same gather-then-compose flow as before, now
  // routed through the shared composeVerifyAndCritique reflection loop instead of a
  // one-shot verify-or-fallback, and the financial-memory summary is appended to the
  // facts the Planner/Composer sees so a session-spanning constraint the user has
  // stated (e.g. "don't touch my emergency fund") is actually available to them.

  private async runLegacyAdvancedPath(
    userId: string,
    question: string,
    advancedIntent: "prioritize_actions" | "goal_conflict" | "risk_tradeoff" | "compare_periods" | "general_search",
    plan: { needsComposition: boolean; needsVerification: boolean },
    planSteps: string[],
  ): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const evidence = await this.gatherer.gather(userId, advancedIntent, question);

    if (!plan.needsComposition) {
      // general_search: RagService already produced a citation-aware, grounded (or
      // honestly "no evidence") answer. There's no local recompose function to retry
      // with Critic guidance here, so this is a flag-only critique (logged, recorded
      // on the run) rather than a full reflect-and-retry — a genuine scoping choice,
      // not an oversight: retrying RAG synthesis with critic guidance would mean
      // reaching into RagService's own prompt, which is out of this feature's scope.
      const ragAnswer = evidence.ragResult?.answer ?? evidence.factsText;
      const ragConfidence = evidence.ragResult?.answerConfidence ?? evidence.ragResult?.retrievalConfidence ?? 0;
      const critique = await this.criticOnly(userId, ragAnswer);

      return {
        question,
        path: "ADVANCED",
        matchedIntent: null,
        advancedIntent,
        plan: planSteps,
        facts: evidence.facts,
        citedSources: evidence.citedSources,
        answer: ragAnswer,
        confidence: ragConfidence,
        verificationPassed: true,
        planId: null,
        createdTaskIds: [],
        criticFlags: critique.flags,
      };
    }

    const memorySummary = await this.financialMemory.summarizeForPrompt(userId);
    const factsText = memorySummary ? `${evidence.factsText}\n\n${memorySummary}` : evidence.factsText;

    const outcome = await this.composeVerifyAndCritique(userId, question, factsText, `coach2.compose_${advancedIntent}`, undefined, plan.needsVerification);

    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent,
      plan: outcome.usedFallback ? [...planSteps, `Fell back to raw facts (${outcome.fallbackReason}).`] : planSteps,
      facts: evidence.facts,
      citedSources: evidence.citedSources,
      answer: outcome.usedFallback ? evidence.factsText : outcome.answer,
      confidence: outcome.confidence,
      verificationPassed: outcome.verificationPassed,
      planId: null,
      createdTaskIds: [],
      criticFlags: outcome.criticFlags,
    };
  }

  // --- create_plan ---------------------------------------------------------------------

  private async runCreatePlan(userId: string, question: string, planSteps: string[]): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const baselineEvidence = await this.gatherer.gatherGoalConflict(userId);

    let parsed: z.infer<typeof planRequestSchema>;
    try {
      const result = await this.gateway.extract(
        `User's request: "${question}"\n\nExtract the plan type, a short title, target amount and/or timeline if stated, ` +
          "and any specific loan or goal referred to by name.",
        planRequestSchema,
        { feature: "coach2.parse_plan_request", promptName: "coach2.parse_plan_request", userId, cacheable: false },
      );
      parsed = result.data;
    } catch (err) {
      return this.unavailableResult(question, "create_plan", planSteps, baselineEvidence.facts, baselineEvidence.citedSources, err);
    }

    const horizonMonths = parsed.months && parsed.months > 0 ? parsed.months : 12; // honest, documented default when the user gave no timeline
    const targetDate = new Date();
    targetDate.setMonth(targetDate.getMonth() + horizonMonths);

    let targetMetricType: "goal_saved_amount" | "loan_outstanding_principal" | "retirement_corpus_gap" | "custom_amount";
    let startingValue: number;
    let targetValue: number;
    const linkedGoalId: string | null = null;
    let linkedLoanId: string | null = null;
    let calculatorFacts = "";

    if (parsed.type === "DEBT_PAYOFF") {
      const { match, candidates } = await this.gatherer.findLoanByHint(userId, parsed.loanNameHint);
      if (!match) {
        return this.clarificationNeededResult(
          question,
          "create_plan",
          planSteps,
          candidates.length === 0
            ? "You don't have any loans on file yet — add one first, then I can build a payoff plan around it."
            : `I found ${candidates.length} loans (${candidates.map((c) => c.lender).join(", ")}) — please specify which one you mean.`,
        );
      }
      targetMetricType = "loan_outstanding_principal";
      linkedLoanId = match.id;
      startingValue = match.outstandingPrincipal;
      targetValue = 0;
      const payoff = await this.calculator.loanPayoffWithExtraMonthly(userId, match.id, 0);
      calculatorFacts = this.calculator.formatPayoffFacts(payoff, 0);
    } else if (parsed.type === "RETIREMENT") {
      targetMetricType = "retirement_corpus_gap";
      const gap = await this.calculator.retirementCorpusGap(userId);
      startingValue = gap.corpusGap;
      targetValue = 0;
      targetDate.setFullYear(new Date().getFullYear() + Math.max(1, gap.yearsToRetirement));
      calculatorFacts = `Current retirement corpus gap: ${formatINR(gap.corpusGap)}. Required monthly SIP to close it: ${formatINR(gap.requiredMonthlySip)}. Years to retirement: ${gap.yearsToRetirement}.`;
    } else {
      // SAVINGS_TARGET, INVESTMENT_ALLOCATION, CUSTOM all track a growing amount
      // toward a stated target — INVESTMENT_ALLOCATION doesn't get bespoke portfolio
      // logic here (that's Investments/Scenario Studio's domain); as a plan it's
      // tracked the same way a savings target is: a starting value growing to a goal.
      // Matching against an existing Goal by name is intentionally NOT attempted here
      // (goalNameHint is parsed but not resolved to a Goal.id) — GoalsService has no
      // fuzzy-name lookup today, and guessing wrong would silently mislink a plan to
      // the wrong goal. linkedGoalId stays null; targetMetricType stays custom_amount.
      if (!parsed.targetAmount) {
        return this.clarificationNeededResult(question, "create_plan", planSteps, "How much would you like this plan's target to be?");
      }
      targetMetricType = "custom_amount";
      startingValue = 0;
      targetValue = parsed.targetAmount;

      const required = this.calculator.requiredMonthlySavingsContribution({
        targetAmount: parsed.targetAmount,
        currentAmount: 0,
        annualReturnPercent: 7,
        months: horizonMonths,
      });
      calculatorFacts = this.calculator.formatRequiredContributionFacts(required, {
        targetAmount: parsed.targetAmount,
        currentAmount: 0,
        annualReturnPercent: 7,
        months: horizonMonths,
      });
    }

    const { planId, steps } = await this.planAgent.createPlan({
      userId,
      type: parsed.type as CoachPlanType,
      title: parsed.title,
      objective: question,
      targetMetricType,
      targetValue,
      targetDate,
      startingValue,
      linkedGoalId,
      linkedLoanId,
    });

    const createdTaskIds = await this.taskAgent.createInitialTasksFromPlan(userId, planId, parsed.title, steps, null);

    const factsText = `${baselineEvidence.factsText}\n\n${calculatorFacts}\n\nPlan created: "${parsed.title}", target ${formatINR(targetValue)} by ${targetDate.toISOString().slice(0, 10)}, starting from ${formatINR(startingValue)}.`;

    const planContext: PlanConsistencyContext = { targetValue, targetDateIso: targetDate.toISOString().slice(0, 10) };
    const outcome = await this.composeVerifyAndCritique(userId, question, factsText, "coach2.compose_create_plan", planContext, true);

    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent: "create_plan",
      plan: outcome.usedFallback ? [...planSteps, `Fell back to raw facts (${outcome.fallbackReason}); the plan itself was still created.`] : planSteps,
      facts: { ...baselineEvidence.facts, planId, targetMetricType, targetValue, targetDate: targetDate.toISOString() },
      citedSources: baselineEvidence.citedSources,
      answer: outcome.usedFallback ? factsText : outcome.answer,
      confidence: outcome.confidence,
      verificationPassed: outcome.verificationPassed,
      planId,
      createdTaskIds,
      criticFlags: outcome.criticFlags,
    };
  }

  // --- plan_progress_check ---------------------------------------------------------------

  private async runPlanProgressCheck(userId: string, question: string, planSteps: string[]): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const plans = await this.planAgent.listPlans(userId);
    const trackedPlans = plans.filter((p) => p.status === "ACTIVE" || p.status === "AT_RISK");

    if (trackedPlans.length === 0) {
      const note = "You don't have any active plans being tracked yet — ask me to set one up (e.g. \"help me pay off my loan in 18 months\").";
      return {
        question,
        path: "ADVANCED",
        matchedIntent: null,
        advancedIntent: "plan_progress_check",
        plan: [...planSteps, "No active plans found — returned a direct, honest answer without needing composition."],
        facts: { planCount: 0 },
        citedSources: [],
        answer: note,
        confidence: 1,
        verificationPassed: true,
        planId: null,
        createdTaskIds: [],
        criticFlags: [],
      };
    }

    const checks: { title: string; planId: string; currentValue: number; expectedValue: number; onTrack: boolean; note: string; status: string; createdTaskId: string | null }[] = [];
    const createdTaskIds: string[] = [];
    for (const p of trackedPlans) {
      const result = await this.planMonitor.checkPlan(userId, p.id, "USER_QUERY");
      checks.push({ title: p.title, ...result });
      if (result.createdTaskId) createdTaskIds.push(result.createdTaskId);
    }

    const factsText = checks
      .map((c) => `"${c.title}": currently ${formatINR(c.currentValue)}, expected ${formatINR(c.expectedValue)} at this point — ${c.note}`)
      .join("\n");

    const planContext: PlanConsistencyContext | undefined =
      trackedPlans.length === 1
        ? { targetValue: Number(trackedPlans[0].targetValue), targetDateIso: trackedPlans[0].targetDate.toISOString().slice(0, 10) }
        : undefined;

    const outcome = await this.composeVerifyAndCritique(userId, question, factsText, "coach2.compose_plan_progress", planContext, true);

    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent: "plan_progress_check",
      plan: outcome.usedFallback ? [...planSteps, `Fell back to raw facts (${outcome.fallbackReason}).`] : planSteps,
      facts: { plans: checks.map((c) => ({ title: c.title, currentValue: c.currentValue, expectedValue: c.expectedValue, onTrack: c.onTrack, status: c.status })) },
      citedSources: [],
      answer: outcome.usedFallback ? factsText : outcome.answer,
      confidence: outcome.confidence,
      verificationPassed: outcome.verificationPassed,
      planId: trackedPlans.length === 1 ? trackedPlans[0].id : null,
      createdTaskIds,
      criticFlags: outcome.criticFlags,
    };
  }

  // --- calculation_request -----------------------------------------------------------------

  private async runCalculationRequest(userId: string, question: string, planSteps: string[]): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    let parsed: z.infer<typeof FinanceCalculatorService.calculationRequestSchema>;
    try {
      const result = await this.gateway.extract(question, FinanceCalculatorService.calculationRequestSchema, {
        feature: "coach2.parse_calculation_request",
        promptName: "coach2.parse_calculation_request",
        userId,
        cacheable: false,
      });
      parsed = result.data;
    } catch (err) {
      return this.unavailableResult(question, "calculation_request", planSteps, {}, [], err);
    }

    let factsText: string;
    try {
      factsText = await this.computeCalculationFacts(userId, parsed);
    } catch (err) {
      return this.clarificationNeededResult(question, "calculation_request", planSteps, (err as Error).message);
    }

    const outcome = await this.composeVerifyAndCritique(userId, question, factsText, "coach2.compose_calculation", undefined, true);

    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent: "calculation_request",
      plan: outcome.usedFallback ? [...planSteps, `Fell back to raw facts (${outcome.fallbackReason}).`] : planSteps,
      facts: { operation: parsed.operation },
      citedSources: [],
      answer: outcome.usedFallback ? factsText : outcome.answer,
      confidence: outcome.confidence,
      verificationPassed: outcome.verificationPassed,
      planId: null,
      createdTaskIds: [],
      criticFlags: outcome.criticFlags,
    };
  }

  private async computeCalculationFacts(userId: string, parsed: z.infer<typeof FinanceCalculatorService.calculationRequestSchema>): Promise<string> {
    switch (parsed.operation) {
      case "hypothetical_emi": {
        if (!parsed.principal || !parsed.annualRatePercent || !parsed.tenureMonths) {
          throw new Error("I need the loan amount, interest rate, and tenure to calculate an EMI.");
        }
        const input = { principal: parsed.principal, annualRatePercent: parsed.annualRatePercent, tenureMonths: parsed.tenureMonths };
        const result = this.calculator.emiForHypotheticalLoan(input.principal, input.annualRatePercent, input.tenureMonths);
        return this.calculator.formatEmiFacts(result, input);
      }
      case "max_affordable_loan": {
        if (!parsed.maxMonthlyEmi || !parsed.annualRatePercent || !parsed.tenureMonths) {
          throw new Error("I need your EMI budget, interest rate, and tenure to calculate the maximum loan you could afford.");
        }
        const input = { maxMonthlyEmi: parsed.maxMonthlyEmi, annualRatePercent: parsed.annualRatePercent, tenureMonths: parsed.tenureMonths };
        const result = this.calculator.maxAffordableLoanPrincipal(input.maxMonthlyEmi, input.annualRatePercent, input.tenureMonths);
        return this.calculator.formatMaxAffordableLoanFacts(result, input);
      }
      case "loan_payoff_with_extra": {
        const { match, candidates } = await this.gatherer.findLoanByHint(userId, parsed.loanNameHint);
        if (!match) {
          throw new Error(
            candidates.length === 0
              ? "You don't have any loans on file to calculate a payoff timeline for."
              : `I found ${candidates.length} loans (${candidates.map((c) => c.lender).join(", ")}) — please specify which one you mean.`,
          );
        }
        const extra = parsed.extraMonthlyPayment ?? 0;
        const result = await this.calculator.loanPayoffWithExtraMonthly(userId, match.id, extra);
        return this.calculator.formatPayoffFacts(result, extra);
      }
      case "savings_projection": {
        if (parsed.currentAmount === undefined || !parsed.monthlyContribution || !parsed.annualReturnPercent || !parsed.months) {
          throw new Error("I need the starting amount, monthly contribution, assumed annual return, and number of months to project this.");
        }
        const input = {
          currentAmount: parsed.currentAmount,
          monthlyContribution: parsed.monthlyContribution,
          annualReturnPercent: parsed.annualReturnPercent,
          months: parsed.months,
        };
        const result = this.calculator.projectSavingsGoal(input);
        return this.calculator.formatSavingsProjectionFacts(result, input);
      }
      case "required_monthly_savings": {
        if (!parsed.targetAmount || parsed.currentAmount === undefined || !parsed.annualReturnPercent || !parsed.months) {
          throw new Error("I need the target amount, current amount, assumed annual return, and number of months to calculate this.");
        }
        const input = {
          targetAmount: parsed.targetAmount,
          currentAmount: parsed.currentAmount,
          annualReturnPercent: parsed.annualReturnPercent,
          months: parsed.months,
        };
        const result = this.calculator.requiredMonthlySavingsContribution(input);
        return this.calculator.formatRequiredContributionFacts(result, input);
      }
      default:
        throw new Error("Unsupported calculation type.");
    }
  }

  // --- Shared reflection loop: compose -> verify -> critic -> (refine once) -> fallback ---

  private async composeVerifyAndCritique(
    userId: string,
    question: string,
    factsText: string,
    promptName: string,
    planContext: PlanConsistencyContext | undefined,
    needsVerification: boolean,
  ): Promise<{ answer: string; confidence: number; verificationPassed: boolean; criticFlags: string[]; usedFallback: boolean; fallbackReason: string | null }> {
    let composed;
    try {
      composed = await this.composer.compose(userId, question, factsText, promptName);
    } catch (err) {
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        this.logger.warn(`Composition unavailable for "${promptName}", returning raw facts: ${(err as Error).message}`);
        return { answer: factsText, confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE, verificationPassed: false, criticFlags: [], usedFallback: true, fallbackReason: "composition_unavailable" };
      }
      throw err;
    }

    const verification = needsVerification ? this.verifierAgent.verify(composed.answer, factsText, planContext) : { passed: true, unmatchedNumbers: [] as string[] };
    const critique = await this.criticOnly(userId, composed.answer);
    const needsRefine = !verification.passed || critique.severity !== "none";

    if (!needsRefine) {
      return { answer: composed.answer, confidence: composed.confidence, verificationPassed: true, criticFlags: [], usedFallback: false, fallbackReason: null };
    }

    const refinementInstruction = !verification.passed
      ? `Your previous answer used a number that isn't in the facts below (${verification.unmatchedNumbers.join(", ")}). Rewrite using ONLY the numbers below.`
      : critique.guidance;

    try {
      const retry = await this.composer.compose(userId, question, `${refinementInstruction}\n\n${factsText}`, promptName);
      const retryVerification = needsVerification ? this.verifierAgent.verify(retry.answer, factsText, planContext) : { passed: true, unmatchedNumbers: [] as string[] };
      const retryCritique = await this.criticOnly(userId, retry.answer);

      if (retryVerification.passed && retryCritique.severity === "none") {
        return { answer: retry.answer, confidence: retry.confidence, verificationPassed: true, criticFlags: [], usedFallback: false, fallbackReason: null };
      }

      this.logger.warn(`"${promptName}" still failed verification/critic after one refine attempt — falling back to raw facts.`);
      return {
        answer: factsText,
        confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE,
        verificationPassed: retryVerification.passed,
        criticFlags: retryCritique.flags,
        usedFallback: true,
        fallbackReason: !retryVerification.passed ? "verification_failed_after_refine" : "critic_flagged_after_refine",
      };
    } catch (err) {
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        return {
          answer: factsText,
          confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE,
          verificationPassed: verification.passed,
          criticFlags: critique.flags,
          usedFallback: true,
          fallbackReason: "refine_unavailable",
        };
      }
      throw err;
    }
  }

  private async criticOnly(userId: string, text: string) {
    try {
      return await this.critic.critique(userId, text);
    } catch (err) {
      this.logger.warn(`Critic Agent failed unexpectedly, treating as unscreened: ${(err as Error).message}`);
      return { flags: [] as string[], severity: "none" as const, guidance: "" };
    }
  }

  private unavailableResult(
    question: string,
    advancedIntent: "create_plan" | "calculation_request",
    planSteps: string[],
    facts: Record<string, unknown>,
    citedSources: string[],
    err: unknown,
  ): Omit<AgenticCoachResult, "staleAdviceNote"> {
    this.logger.warn(`Could not parse "${advancedIntent}" request (AI unavailable): ${(err as Error).message}`);
    const answer = "I'm having trouble understanding the specifics of that request right now — could you restate it with the exact numbers and timeline?";
    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent,
      plan: [...planSteps, "Could not parse the request (AI unavailable) — asked for clarification instead of guessing."],
      facts,
      citedSources,
      answer,
      confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE,
      verificationPassed: false,
      planId: null,
      createdTaskIds: [],
      criticFlags: [],
    };
  }

  private clarificationNeededResult(
    question: string,
    advancedIntent: "create_plan" | "calculation_request",
    planSteps: string[],
    message: string,
  ): Omit<AgenticCoachResult, "staleAdviceNote"> {
    return {
      question,
      path: "ADVANCED",
      matchedIntent: null,
      advancedIntent,
      plan: [...planSteps, "Needed clarification before proceeding — no plan/calculation was invented from incomplete data."],
      facts: {},
      citedSources: [],
      answer: message,
      confidence: 1, // this is an honest, direct request for information, not a model claim
      verificationPassed: true,
      planId: null,
      createdTaskIds: [],
      criticFlags: [],
    };
  }
}
