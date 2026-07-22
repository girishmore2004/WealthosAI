import { Injectable, BadRequestException } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { ScenarioPromptParserService } from "./parsing/scenario-prompt-parser.service";
import { ScenarioExpanderService, ScenarioVariant } from "./expansion/scenario-expander.service";
import { SensitivityAnalysisService, SensitivityDimension } from "./sensitivity/sensitivity-analysis.service";
import { ScenarioRankingService, RankedVariant } from "./ranking/scenario-ranking.service";
import { ScenarioExplainerService } from "./explanation/scenario-explainer.service";
import { ScenarioType } from "@wealthos/types";

export interface ScenarioStudioResult {
  prompt: string;
  understood: boolean;
  scenarioType: ScenarioType | null;
  baseParams: Record<string, unknown>;
  variants: ScenarioVariant[];
  sensitivity: SensitivityDimension[];
  ranked: RankedVariant[];
  explanation: string;
  explanationConfidence: number;
  verificationPassed: boolean;
}

@Injectable()
export class ScenarioStudioService {
  constructor(
    private prisma: PrismaService,
    private parser: ScenarioPromptParserService,
    private expander: ScenarioExpanderService,
    private sensitivity: SensitivityAnalysisService,
    private ranking: ScenarioRankingService,
    private explainer: ScenarioExplainerService,
  ) {}

  async build(userId: string, prompt: string, targetGoalIds: string[] = []): Promise<ScenarioStudioResult> {
    const parsed = await this.parser.parse(userId, prompt);

    if (!parsed.understood || !parsed.scenarioType) {
      return {
        prompt,
        understood: false,
        scenarioType: null,
        baseParams: {},
        variants: [],
        sensitivity: [],
        ranked: [],
        explanation:
          "I couldn't match this to one of the supported scenario types (salary change, SIP change, house purchase, loan prepayment, retirement age shift, emergency expense, or goal delay). Try rephrasing with a specific number, e.g. \"what if I increase my SIP by ₹5,000/month\".",
        explanationConfidence: 1,
        verificationPassed: true,
      };
    }

    // SimulatorService.run() (called inside the expander) is the same validation
    // used by the existing /simulator/run endpoint — a missing/wrong-shaped field
    // throws a clear BadRequestException here rather than silently proceeding, same
    // as it always has for that endpoint.
    let variants: ScenarioVariant[];
    try {
      variants = await this.expander.expand(userId, parsed.scenarioType, parsed.params);
    } catch (err) {
      if (err instanceof BadRequestException) {
        return {
          prompt,
          understood: true,
          scenarioType: parsed.scenarioType,
          baseParams: parsed.params,
          variants: [],
          sensitivity: [],
          ranked: [],
          explanation: `I understood this as a ${parsed.scenarioType} scenario, but couldn't extract enough detail from your prompt: ${err.message}. Try including the specific number.`,
          explanationConfidence: 1,
          verificationPassed: true,
        };
      }
      throw err;
    }

    const baseVariant = variants.find((v) => v.label === "base")!;
    const [sensitivityDimensions, ranked] = await Promise.all([
      this.sensitivity.analyze(userId, parsed.scenarioType, parsed.params, baseVariant.run),
      this.ranking.rank(userId, variants, targetGoalIds),
    ]);

    const explanation = await this.explainer.explain(userId, parsed.scenarioType, variants, ranked);

    const result: ScenarioStudioResult = {
      prompt,
      understood: true,
      scenarioType: parsed.scenarioType,
      baseParams: parsed.params,
      variants,
      sensitivity: sensitivityDimensions,
      ranked,
      explanation: explanation.text,
      explanationConfidence: explanation.confidence,
      verificationPassed: explanation.verificationPassed,
    };

    await this.logRun(userId, result, targetGoalIds);
    return result;
  }

  private async logRun(userId: string, result: ScenarioStudioResult, targetGoalIds: string[]): Promise<void> {
    try {
      await this.prisma.client.scenarioStudioRun.create({
        data: {
          userId,
          prompt: result.prompt,
          scenarioType: result.scenarioType ?? "UNKNOWN",
          baseParams: result.baseParams as object,
          targetGoalIds,
          variants: result.variants.map((v) => ({
            label: v.label,
            params: v.params,
            netWorthDeltaIn5Years: v.run.result.netWorthDeltaIn5Years,
            projectedNetWorthIn5Years: v.run.result.projectedNetWorthIn5Years,
            monthlyCashflowDelta: v.run.result.monthlyCashflowDelta,
            feasible: v.feasible,
            feasibilityNote: v.feasibilityNote,
          })) as object,
          sensitivity: result.sensitivity as object,
          rankedOrder: result.ranked.map((r) => r.label),
          explanation: result.explanation,
          explanationConfidence: result.explanationConfidence,
          verificationPassed: result.verificationPassed,
        },
      });
    } catch {
      // Same reasoning as every other logging call in this codebase's AI layer: a
      // logging failure must never fail the actual result being returned.
    }
  }

  async history(userId: string, take = 20) {
    return this.prisma.client.scenarioStudioRun.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take,
    });
  }
}
