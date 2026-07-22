import { Injectable, Logger } from "@nestjs/common";
import { CoachService } from "../../coach/coach.service";
import { IntentClassifierService } from "./planning/intent-classifier.service";
import { PlannerService } from "./planning/planner.service";
import { DataGathererService } from "./gathering/data-gatherer.service";
import { AnswerComposerService } from "./composition/answer-composer.service";
import { NumericConsistencyVerifier } from "./verification/numeric-consistency.verifier";
import { CoachMemoryService } from "./memory/coach-memory.service";
import { AiUnavailableException, AiValidationException } from "../exceptions/ai.exceptions";

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
}

const FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE = 0.5;

@Injectable()
export class AgenticCoachService {
  private readonly logger = new Logger(AgenticCoachService.name);

  constructor(
    private coach: CoachService,
    private classifier: IntentClassifierService,
    private planner: PlannerService,
    private gatherer: DataGathererService,
    private composer: AnswerComposerService,
    private verifier: NumericConsistencyVerifier,
    private memory: CoachMemoryService,
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
    });

    return { ...result, staleAdviceNote };
  }

  async history(userId: string, take = 20) {
    return this.memory.history(userId, take);
  }

  private async runDeterministicPath(
    userId: string,
    question: string,
    matchedIntent: string,
    planSteps: string[],
  ): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    // Reuses the existing v1 endpoint's own logic and, deliberately, its own
    // CoachInteraction write — a deterministic-path v2 answer IS a v1 answer, so v1's
    // history stays complete and consistent whether the user called /coach/ask or
    // /coach/v2/ask.
    const v1Interaction = await this.coach.ask(userId, question);
    const facts = { baseAnswer: v1Interaction.answer, dataSources: v1Interaction.dataSources };
    const factsText = `${v1Interaction.answer}\n(Grounded in: ${v1Interaction.dataSources.join(", ") || "none"})`;

    try {
      const composed = await this.composer.compose(userId, question, factsText, "coach2.explain_deterministic");
      return {
        question,
        path: "DETERMINISTIC",
        matchedIntent,
        advancedIntent: null,
        plan: planSteps,
        facts,
        citedSources: [],
        answer: composed.answer,
        confidence: composed.confidence,
        verificationPassed: true, // not applicable — see PlannerService.needsVerification
      };
    } catch (err) {
      // Composition here is a pure enhancement over an already-complete, already-
      // grounded answer — if the model is unavailable or produces something
      // unusable, fall back to the original deterministic answer verbatim rather
      // than fail a request that already has a perfectly good answer sitting right
      // there.
      this.logger.warn(`Deterministic-path composition unavailable, using base answer verbatim: ${(err as Error).message}`);
      return {
        question,
        path: "DETERMINISTIC",
        matchedIntent,
        advancedIntent: null,
        plan: [...planSteps, "Composition was unavailable — returned the base deterministic answer unmodified."],
        facts,
        citedSources: [],
        answer: v1Interaction.answer,
        confidence: 1, // the base deterministic answer is code output, not a model claim — maximally trustworthy by construction
        verificationPassed: true,
      };
    }
  }

  private async runAdvancedPath(
    userId: string,
    question: string,
    advancedIntent: "prioritize_actions" | "goal_conflict" | "risk_tradeoff" | "compare_periods" | "general_search",
    plan: { steps: { description: string }[]; needsComposition: boolean; needsVerification: boolean },
  ): Promise<Omit<AgenticCoachResult, "staleAdviceNote">> {
    const planSteps = plan.steps.map((s) => s.description);
    const evidence = await this.gatherer.gather(userId, advancedIntent, question);

    if (!plan.needsComposition) {
      // general_search: RagService already produced a citation-aware, grounded (or
      // honestly "no evidence") answer — use it directly rather than composing again.
      const ragAnswer = evidence.ragResult?.answer ?? evidence.factsText;
      const ragConfidence = evidence.ragResult?.answerConfidence ?? evidence.ragResult?.retrievalConfidence ?? 0;
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
      };
    }

    try {
      const composed = await this.composer.compose(userId, question, evidence.factsText, `coach2.compose_${advancedIntent}`);
      const verification = plan.needsVerification
        ? this.verifier.verify(composed.answer, evidence.factsText)
        : { passed: true, unmatchedNumbers: [] as string[] };

      if (verification.passed) {
        return {
          question,
          path: "ADVANCED",
          matchedIntent: null,
          advancedIntent,
          plan: planSteps,
          facts: evidence.facts,
          citedSources: evidence.citedSources,
          answer: composed.answer,
          confidence: composed.confidence,
          verificationPassed: true,
        };
      }

      // The composed answer introduced at least one number that doesn't trace back to
      // the gathered facts — do not return it. Fall back to the facts themselves,
      // which are always safe (they're deterministic computation, not model output).
      this.logger.warn(
        `Composed answer for "${advancedIntent}" failed numeric verification (unmatched: ${verification.unmatchedNumbers.join(", ")}) — falling back to raw facts.`,
      );
      return {
        question,
        path: "ADVANCED",
        matchedIntent: null,
        advancedIntent,
        plan: [...planSteps, `Verification failed (composed answer contained unverifiable figures: ${verification.unmatchedNumbers.join(", ")}) — returned the underlying facts directly instead.`],
        facts: evidence.facts,
        citedSources: evidence.citedSources,
        answer: evidence.factsText,
        confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE,
        verificationPassed: false,
      };
    } catch (err) {
      if (err instanceof AiUnavailableException || err instanceof AiValidationException) {
        this.logger.warn(`Composition unavailable for "${advancedIntent}", returning raw facts: ${(err as Error).message}`);
        return {
          question,
          path: "ADVANCED",
          matchedIntent: null,
          advancedIntent,
          plan: [...planSteps, "Composition was unavailable — returned the underlying gathered facts directly instead."],
          facts: evidence.facts,
          citedSources: evidence.citedSources,
          answer: evidence.factsText,
          confidence: FALLBACK_CONFIDENCE_ON_VERIFICATION_FAILURE,
          verificationPassed: false,
        };
      }
      throw err;
    }
  }
}
