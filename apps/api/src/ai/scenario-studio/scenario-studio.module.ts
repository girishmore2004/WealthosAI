import { Module } from "@nestjs/common";
import { AiModule } from "../ai.module";
import { SimulatorModule } from "../../simulator/simulator.module";
import { LoansModule } from "../../loans/loans.module";
import { GoalsModule } from "../../goals/goals.module";
import { InvestmentsModule } from "../../investments/investments.module";
import { TaxModule } from "../../tax/tax.module";
import { NumericConsistencyVerifier } from "../coach/verification/numeric-consistency.verifier";
import { ScenarioPromptParserService } from "./parsing/scenario-prompt-parser.service";
import { ScenarioExpanderService } from "./expansion/scenario-expander.service";
import { SensitivityAnalysisService } from "./sensitivity/sensitivity-analysis.service";
import { ScenarioRankingService } from "./ranking/scenario-ranking.service";
import { ScenarioExplainerService } from "./explanation/scenario-explainer.service";
import { MonteCarloSimulationService } from "./monte-carlo/monte-carlo-simulation.service";
import { ScenarioOptimizerService } from "./optimization/scenario-optimizer.service";
import { ScenarioStudioService } from "./scenario-studio.service";
import { ScenarioStudioController } from "./scenario-studio.controller";

// Deliberately does NOT import AgenticCoachModule just to reuse
// NumericConsistencyVerifier — that class has no dependencies of its own (a pure
// stateless verifier), so it's cheaper and less coupling to register it as its own
// provider here too than to pull in the entire Coach module graph for one helper.
//
// TaxModule is new for the probabilistic-planning feature: ScenarioOptimizerService's
// constraint solver checks a SIP_INCREASE recommendation against the user's real,
// currently-logged Section 80C headroom via TaxService rather than a hardcoded
// tax-advantaged limit — see scenario-optimizer.service.ts's
// remaining80CHeadroomMonthly().
@Module({
  imports: [AiModule, SimulatorModule, LoansModule, GoalsModule, InvestmentsModule, TaxModule],
  controllers: [ScenarioStudioController],
  providers: [
    ScenarioPromptParserService,
    ScenarioExpanderService,
    SensitivityAnalysisService,
    ScenarioRankingService,
    NumericConsistencyVerifier,
    ScenarioExplainerService,
    MonteCarloSimulationService,
    ScenarioOptimizerService,
    ScenarioStudioService,
  ],
  exports: [ScenarioStudioService],
})
export class ScenarioStudioModule {}
