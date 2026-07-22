import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { SimulatorModule } from "../../simulator/simulator.module";
import { LoansModule } from "../../loans/loans.module";
import { GoalsModule } from "../../goals/goals.module";
import { NumericConsistencyVerifier } from "../coach/verification/numeric-consistency.verifier";
import { ScenarioPromptParserService } from "./parsing/scenario-prompt-parser.service";
import { ScenarioExpanderService } from "./expansion/scenario-expander.service";
import { SensitivityAnalysisService } from "./sensitivity/sensitivity-analysis.service";
import { ScenarioRankingService } from "./ranking/scenario-ranking.service";
import { ScenarioExplainerService } from "./explanation/scenario-explainer.service";
import { ScenarioStudioService } from "./scenario-studio.service";
import { ScenarioStudioController } from "./scenario-studio.controller";

// Deliberately does NOT import AgenticCoachModule just to reuse
// NumericConsistencyVerifier — that class has no dependencies of its own (a pure
// stateless verifier), so it's cheaper and less coupling to register it as its own
// provider here too than to pull in the entire Coach module graph for one helper.
@Module({
  imports: [AiModule, SimulatorModule, LoansModule, GoalsModule],
  controllers: [ScenarioStudioController],
  providers: [
    ScenarioPromptParserService,
    ScenarioExpanderService,
    SensitivityAnalysisService,
    ScenarioRankingService,
    NumericConsistencyVerifier,
    ScenarioExplainerService,
    ScenarioStudioService,
  ],
  exports: [ScenarioStudioService],
})
export class ScenarioStudioModule {}
