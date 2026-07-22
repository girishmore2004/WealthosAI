import { Injectable } from "@nestjs/common";
import { PrismaService } from "../../prisma/prisma.service";
import { FeatureExtractionService } from "./features/feature-extraction.service";
import { AnomalyDetectionModel, ExpenseAnomaly } from "./models/anomaly-detection.model";
import { CashflowForecastModel, CashflowForecast } from "./models/cashflow-forecast.model";
import { DebtRiskModel, DebtRiskPrediction } from "./models/debt-risk.model";
import { GoalSuccessModel, GoalSuccessPrediction } from "./models/goal-success.model";
import { DriftDetectionModel, DriftPrediction } from "./models/drift-detection.model";
import { HabitSegmentationModel, MonthSegment } from "./models/habit-segmentation.model";
import { GoalsService } from "../../goals/goals.service";
import { LoansService } from "../../loans/loans.service";
import { DashboardService } from "../../dashboard/dashboard.service";
import { ModelOutput } from "./model-output.types";

export interface MlInsightsSummary {
  anomalies: ModelOutput<ExpenseAnomaly[]>;
  cashflowForecast: ModelOutput<CashflowForecast>;
  debtRisk: ModelOutput<DebtRiskPrediction>;
  goalSuccess: ModelOutput<GoalSuccessPrediction[]>;
  drift: ModelOutput<DriftPrediction>;
  habitSegmentation: ModelOutput<MonthSegment[]>;
}

@Injectable()
export class MlInsightsService {
  constructor(
    private prisma: PrismaService,
    private features: FeatureExtractionService,
    private anomalyModel: AnomalyDetectionModel,
    private cashflowModel: CashflowForecastModel,
    private debtRiskModel: DebtRiskModel,
    private goalSuccessModel: GoalSuccessModel,
    private driftModel: DriftDetectionModel,
    private habitModel: HabitSegmentationModel,
    private goals: GoalsService,
    private loans: LoansService,
    private dashboard: DashboardService,
  ) {}

  async summary(userId: string): Promise<MlInsightsSummary> {
    const [transactions, monthlySeries, goals, debtSummary, dashboardSummary] = await Promise.all([
      this.features.transactionPoints(userId),
      this.features.monthlySeries(userId),
      this.goals.list(userId),
      this.loans.debtSummary(userId),
      this.dashboard.getSummary(userId),
    ]);

    const result: MlInsightsSummary = {
      anomalies: this.anomalyModel.detect(transactions),
      cashflowForecast: this.cashflowModel.forecast(monthlySeries),
      debtRisk: this.debtRiskModel.score({
        totalOutstanding: Number(debtSummary.totalOutstanding),
        totalMonthlyEmi: Number(debtSummary.totalMonthlyEmi),
        monthlyIncome: Number(dashboardSummary.monthlyIncome),
        loans: debtSummary.loans.map((l) => ({ outstandingPrincipal: Number(l.outstandingPrincipal), interestRateAnnual: Number(l.interestRateAnnual) })),
      }),
      goalSuccess: this.goalSuccessModel.score(goals),
      drift: this.driftModel.detect(monthlySeries),
      habitSegmentation: this.habitModel.segment(monthlySeries),
    };

    await this.logRun(userId, result);
    return result;
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
          summary: result as unknown as object,
        },
      });
    } catch {
      // Same reasoning as every other logging call in this codebase's AI layer.
    }
  }

  async history(userId: string, take = 20) {
    return this.prisma.client.mlInsightRun.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take });
  }
}
