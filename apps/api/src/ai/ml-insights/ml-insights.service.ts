import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { FeatureExtractionService } from "./features/feature-extraction.service";
import { buildFeatureMonitoringWindows } from "./features/feature-monitoring-windows.util";
import { buildForecastActualPairs } from "./history/concept-drift-pairs.util";
import { AnomalyDetectionModel, ExpenseAnomaly } from "./models/anomaly-detection.model";
import { CashflowForecastModel, CashflowForecast } from "./models/cashflow-forecast.model";
import { MetricsForecastModel, MetricsForecast } from "./models/metrics-forecast.model";
import { DebtRiskModel, DebtRiskPrediction } from "./models/debt-risk.model";
import { GoalSuccessModel, GoalSuccessPrediction } from "./models/goal-success.model";
import { DriftDetectionModel, DriftPrediction } from "./models/drift-detection.model";
import { ConceptDriftModel, ConceptDriftPrediction } from "./models/concept-drift.model";
import { FeatureMonitoringModel, FeatureMonitoringPrediction } from "./models/feature-monitoring.model";
import { HabitSegmentationModel, MonthSegment } from "./models/habit-segmentation.model";
import { BehavioralFeaturesModel, BehavioralFeatureResult } from "./models/behavioral-features.model";
import { AnomalyExplanationService, AnomalyExplanationResult } from "./explanation/anomaly-explanation.service";
import { GoalsService } from "../../goals/goals.service";
import { LoansService } from "../../loans/loans.service";
import { DashboardService } from "../../dashboard/dashboard.service";
import { ModelOutput } from "./model-output.types";

export interface MlInsightsSummary {
  anomalies: ModelOutput<ExpenseAnomaly[]>;
  /** NEW — LLM-composed (via AI Gateway) narrative of why the top anomalies were
   * flagged, grounded in AnomalyDetectionModel's own deterministic likelyCauses, with
   * a guaranteed non-LLM fallback (see AnomalyExplanationService). */
  anomalyExplanation: AnomalyExplanationResult;
  cashflowForecast: ModelOutput<CashflowForecast>;
  /** NEW — independent Bayesian quantile forecasts for income, expenses, and savings
   * rate (the audit's explicit "income, expenses, savings" ask), separate from the
   * combined net-cashflow forecast above. */
  metricsForecast: ModelOutput<MetricsForecast>;
  debtRisk: ModelOutput<DebtRiskPrediction>;
  goalSuccess: ModelOutput<GoalSuccessPrediction[]>;
  /** Existing: has the USER's savings rate itself shifted (spending/behavior drift). */
  drift: ModelOutput<DriftPrediction>;
  /** NEW — has the cashflow FORECAST MODEL's own prediction error gotten worse over
   * time (model performance monitoring / concept drift, not spending drift). */
  conceptDrift: ModelOutput<ConceptDriftPrediction>;
  /** NEW — online monitoring of engineered feature distributions (transaction size,
   * frequency, category diversity) for a shift between a reference window and the
   * recent window, via Population Stability Index. */
  featureMonitoring: ModelOutput<FeatureMonitoringPrediction>;
  habitSegmentation: ModelOutput<MonthSegment[]>;
  /** NEW — user-specific engineered behavioral features plus a rule-based spending
   * cluster label. */
  behavioralFeatures: ModelOutput<BehavioralFeatureResult>;
}

@Injectable()
export class MlInsightsService {
  constructor(
    private prisma: PrismaService,
    private features: FeatureExtractionService,
    private anomalyModel: AnomalyDetectionModel,
    private cashflowModel: CashflowForecastModel,
    private metricsForecastModel: MetricsForecastModel,
    private debtRiskModel: DebtRiskModel,
    private goalSuccessModel: GoalSuccessModel,
    private driftModel: DriftDetectionModel,
    private conceptDriftModel: ConceptDriftModel,
    private featureMonitoringModel: FeatureMonitoringModel,
    private habitModel: HabitSegmentationModel,
    private behavioralFeaturesModel: BehavioralFeaturesModel,
    private anomalyExplanation: AnomalyExplanationService,
    private goals: GoalsService,
    private loans: LoansService,
    private dashboard: DashboardService,
  ) {}

  async summary(userId: string): Promise<MlInsightsSummary> {
    const [transactions, monthlySeries, categorySeries, goals, debtSummary, dashboardSummary, priorRuns] = await Promise.all([
      this.features.transactionPoints(userId),
      this.features.monthlySeries(userId),
      this.features.categoryMonthlySeries(userId),
      this.goals.list(userId),
      this.loans.debtSummary(userId),
      this.dashboard.getSummary(userId),
      this.priorForecastRuns(userId),
    ]);

    const anomalies = this.anomalyModel.detect(transactions);
    const cashflowForecast = this.cashflowModel.forecast(monthlySeries);
    const metricsForecast = this.metricsForecastModel.forecast(monthlySeries);
    const conceptDriftPairs = buildForecastActualPairs(priorRuns, monthlySeries);
    const featureWindows = buildFeatureMonitoringWindows(transactions, monthlySeries);

    // The only network/LLM call in this whole summary — everything else above and
    // below is deterministic/pure. Awaited last among the "compute" steps so a slow
    // or failed Groq call never blocks the deterministic models from having already
    // run; AnomalyExplanationService itself guarantees a same-shape result either way
    // (see its own fallback handling), so this never needs a try/catch here.
    const anomalyExplanation = await this.anomalyExplanation.explain(userId, anomalies.prediction);

    const result: MlInsightsSummary = {
      anomalies,
      anomalyExplanation,
      cashflowForecast,
      metricsForecast,
      debtRisk: this.debtRiskModel.score({
        totalOutstanding: Number(debtSummary.totalOutstanding),
        totalMonthlyEmi: Number(debtSummary.totalMonthlyEmi),
        monthlyIncome: Number(dashboardSummary.monthlyIncome),
        loans: debtSummary.loans.map((l) => ({ outstandingPrincipal: Number(l.outstandingPrincipal), interestRateAnnual: Number(l.interestRateAnnual) })),
      }),
      goalSuccess: this.goalSuccessModel.score(goals),
      drift: this.driftModel.detect(monthlySeries),
      conceptDrift: this.conceptDriftModel.detect(conceptDriftPairs),
      featureMonitoring: this.featureMonitoringModel.detect(featureWindows),
      habitSegmentation: this.habitModel.segment(monthlySeries),
      behavioralFeatures: this.behavioralFeaturesModel.extract({ monthlySeries, transactions, categorySeries }),
    };

    await this.logRun(userId, result);
    return result;
  }

  /** Fetches just enough of this user's own MlInsightRun history (createdAt +
   * the stored cashflow forecast) for buildForecastActualPairs() to pair past
   * predictions against now-known actuals. Capped at 24 rows — comfortably more than
   * the ~6 resolved pairs ConceptDriftModel actually needs, without pulling every run
   * a long-tenured user has ever had. */
  private async priorForecastRuns(userId: string): Promise<{ createdAt: Date; predictedNextMonthCashflow: number }[]> {
    try {
      const runs = await this.prisma.client.mlInsightRun.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        take: 24,
        select: { createdAt: true, summary: true },
      });

      return runs
        .map((r) => {
          const summary = r.summary as unknown as { cashflowForecast?: { prediction?: { nextMonthProjectedCashflow?: number } } } | null;
          const predicted = summary?.cashflowForecast?.prediction?.nextMonthProjectedCashflow;
          return typeof predicted === "number" ? { createdAt: r.createdAt, predictedNextMonthCashflow: predicted } : null;
        })
        .filter((r): r is { createdAt: Date; predictedNextMonthCashflow: number } => r !== null);
    } catch {
      // Same fail-open reasoning as logRun below — concept drift monitoring degrades
      // to "not enough history yet" (ConceptDriftModel's own `monitored: false` path)
      // rather than breaking the rest of the summary if history can't be read.
      return [];
    }
  }

  private async logRun(userId: string, result: MlInsightsSummary): Promise<void> {
    try {
      await this.prisma.client.mlInsightRun.create({
        data: {
          userId,
          anomalyCount: result.anomalies.prediction.length,
          cashflowStressRisk: result.cashflowForecast.prediction.stressRisk,
          debtRiskScore: result.debtRisk.prediction.riskScore,
          debtRiskTier: result.debtRisk.prediction.tier,
          driftDetected: result.drift.prediction.drifted,
          driftDirection: result.drift.prediction.direction,
          conceptDriftDetected: result.conceptDrift.prediction.driftDetected,
          featureShiftDetected: result.featureMonitoring.prediction.anyShiftDetected,
          summary: result as unknown as object,
        },
      });
    } catch {
      // Same reasoning as every other logging call in this codebase's AI layer:
      // history logging is best-effort observability, never a reason to fail the
      // request the user is actually waiting on.
    }
  }

  async history(userId: string, take = 20) {
    return this.prisma.client.mlInsightRun.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
  }
}
