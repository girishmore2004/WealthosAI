import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { RetirementService } from "../retirement/retirement.service";
import { GoalsService } from "../goals/goals.service";
import { calculateAge } from "../common/utils/age.util";
import { runScenario, ScenarioContext } from "./simulator.engine";
import {
  RunScenarioResponseDTO,
  SavedScenarioDTO,
  ScenarioBaselineDTO,
  ScenarioParamsByType,
  ScenarioType,
} from "@wealthos/types";

// Every field a given scenario type requires, so a missing/wrong-shaped param produces
// a clear 400 instead of silently becoming NaN inside the pure engine.
const REQUIRED_FIELDS: Record<ScenarioType, string[]> = {
  SALARY_HIKE: ["percentIncrease"],
  SALARY_DROP: ["percentDecrease"],
  SIP_INCREASE: ["additionalMonthlyAmount"],
  SIP_DECREASE: ["reducedMonthlyAmount"],
  HOUSE_PURCHASE: ["propertyValue", "downPaymentPercent", "loanInterestRateAnnual", "loanTenureMonths"],
  LOAN_PREPAYMENT: ["loanId", "lumpSum"],
  RETIREMENT_AGE_SHIFT: ["newRetirementAge"],
  EMERGENCY_EXPENSE: ["amount"],
  GOAL_DELAY: ["goalId", "delayMonths"],
};

@Injectable()
export class SimulatorService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
    private expensesService: ExpensesService,
    private investmentsService: InvestmentsService,
    private loansService: LoansService,
    private retirementService: RetirementService,
    private goalsService: GoalsService,
  ) {}

  private validateParams<T extends ScenarioType>(scenarioType: T, params: Record<string, unknown>): ScenarioParamsByType[T] {
    const required = REQUIRED_FIELDS[scenarioType];
    const missing = required.filter((field) => params[field] === undefined || params[field] === null);
    if (missing.length > 0) {
      throw new BadRequestException(`Missing required field(s) for ${scenarioType}: ${missing.join(", ")}`);
    }
    for (const field of required) {
      if (field !== "loanId" && field !== "goalId" && typeof params[field] !== "number") {
        throw new BadRequestException(`Field "${field}" for ${scenarioType} must be a number`);
      }
    }
    return params as ScenarioParamsByType[T];
  }

  private async buildBaseline(userId: string): Promise<ScenarioBaselineDTO> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [monthlyIncome, monthExpenses, allIncomes, allExpenses, investmentsValue, totalDebt, user, retirementProfile] =
      await Promise.all([
        this.incomeService.monthlyForecast(userId),
        this.expensesService.list(userId, currentMonth),
        this.incomeService.list(userId),
        this.expensesService.list(userId),
        this.investmentsService.totalCurrentValue(userId),
        this.loansService.totalOutstanding(userId),
        this.prisma.client.user.findUnique({ where: { id: userId } }),
        this.retirementService.getOrCreateProfile(userId),
      ]);

    const monthlyExpenses = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const cash = allIncomes.reduce((s, i) => s + Number(i.amount), 0) - allExpenses.reduce((s, e) => s + Number(e.amount), 0);

    return {
      monthlyIncome,
      monthlyExpenses,
      netWorth: cash + investmentsValue - totalDebt,
      investmentsValue,
      totalDebt,
      currentAge: user?.dateOfBirth ? calculateAge(user.dateOfBirth) : null,
      targetRetirementAge: retirementProfile.targetRetirementAge,
    };
  }

  // Gathers real numbers for the scenario types whose narrative depends on another
  // module's own (already-tested) calculation — never re-derives that math itself.
  private async buildContext(userId: string, scenarioType: ScenarioType, params: Record<string, unknown>): Promise<ScenarioContext> {
    if (scenarioType === "LOAN_PREPAYMENT") {
      const p = params as ScenarioParamsByType["LOAN_PREPAYMENT"];
      try {
        const impact = await this.loansService.prepaymentImpact(userId, p.loanId, p.lumpSum);
        return { loanPrepayment: impact };
      } catch {
        return {}; // loan not found/not owned — engine falls back to a context-free answer
      }
    }

    if (scenarioType === "RETIREMENT_AGE_SHIFT") {
      const plan = await this.retirementService.computePlan(userId);
      return { retirementCorpusRequired: Number(plan.corpusRequired) };
    }

    if (scenarioType === "GOAL_DELAY") {
      const p = params as ScenarioParamsByType["GOAL_DELAY"];
      const goals = await this.goalsService.list(userId);
      const goal = goals.find((g) => g.id === p.goalId);
      if (!goal) return {};

      // Re-derives "months remaining" the same way GoalsService.enrich() does internally
      // (that method is private, so this is a small, intentional, localized duplication
      // rather than exposing internals just for this one call site).
      const targetAmount = Number(goal.targetAmount);
      const totalSaved = Number(goal.currentAmount) + Number(goal.linkedInvestmentValue);
      const remaining = Math.max(0, targetAmount - totalSaved);
      const currentMonthsRemaining = Math.max(1, Math.ceil((new Date(goal.targetDate).getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)));
      const newMonthsRemaining = currentMonthsRemaining + p.delayMonths;
      const newRequiredMonthlyContribution = newMonthsRemaining > 0 ? remaining / newMonthsRemaining : 0;

      return {
        goalDelay: {
          goalName: goal.name,
          currentRequiredMonthlyContribution: goal.requiredMonthlyContribution,
          newRequiredMonthlyContribution,
        },
      };
    }

    return {};
  }

  async run(userId: string, scenarioType: ScenarioType, rawParams: Record<string, unknown>): Promise<RunScenarioResponseDTO> {
    const params = this.validateParams(scenarioType, rawParams);
    const [baseline, context] = await Promise.all([
      this.buildBaseline(userId),
      this.buildContext(userId, scenarioType, rawParams),
    ]);
    const result = runScenario(scenarioType, params, baseline, context);
    return { baseline, result };
  }

  async save(userId: string, scenarioType: ScenarioType, rawParams: Record<string, unknown>, label: string): Promise<SavedScenarioDTO> {
    const { result } = await this.run(userId, scenarioType, rawParams);
    const saved = await this.prisma.client.savedScenario.create({
      data: { userId, scenarioType, label, params: rawParams as never, resultSnapshot: result as never },
    });
    return this.toDTO(saved);
  }

  async listSaved(userId: string): Promise<SavedScenarioDTO[]> {
    const rows = await this.prisma.client.savedScenario.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => this.toDTO(r));
  }

  async removeSaved(userId: string, id: string): Promise<void> {
    const row = await this.prisma.client.savedScenario.findUnique({ where: { id } });
    if (!row) throw new NotFoundException("Saved scenario not found");
    if (row.userId !== userId) throw new ForbiddenException();
    await this.prisma.client.savedScenario.delete({ where: { id } });
  }

  // Comparison is just "fetch these saved rows, ownership-checked" — the actual
  // side-by-side diffing is presentation logic in the frontend, not recomputed here.
  async compare(userId: string, ids: string[]): Promise<SavedScenarioDTO[]> {
    const rows = await this.prisma.client.savedScenario.findMany({
      where: { id: { in: ids }, userId },
    });
    return rows.map((r) => this.toDTO(r));
  }

  private toDTO(row: {
    id: string;
    scenarioType: string;
    label: string;
    params: unknown;
    resultSnapshot: unknown;
    createdAt: Date;
  }): SavedScenarioDTO {
    return {
      id: row.id,
      scenarioType: row.scenarioType as ScenarioType,
      label: row.label,
      params: row.params as Record<string, unknown>,
      result: row.resultSnapshot as SavedScenarioDTO["result"],
      createdAt: row.createdAt.toISOString(),
    };
  }
}
