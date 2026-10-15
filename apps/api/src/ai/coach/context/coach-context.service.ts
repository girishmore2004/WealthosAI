import { Injectable } from "@nestjs/common";
import { GoalDTO } from "@wealthos/types";
import { IncomeService } from "../../../income/income.service";
import { ExpensesService } from "../../../expenses/expenses.service";
import { LoansService } from "../../../loans/loans.service";
import { GoalsService } from "../../../goals/goals.service";
import { InvestmentsService } from "../../../investments/investments.service";
import { InsuranceService } from "../../../insurance/insurance.service";
import { RetirementService } from "../../../retirement/retirement.service";
import { EmergencyFundService } from "../../../financial-core/emergency-fund/emergency-fund.service";
import { FinancialFactsService } from "../../../common/financial-facts/financial-facts.service";
import { FinancialMemoryService } from "../memory/financial-memory.service";
import {
  CategoryBreakdown,
  GoalAssessment,
  MonthStatus,
  RecordedAmount,
  assessGoal,
  buildCategoryBreakdown,
  monthStatus,
  recorded,
} from "../analysis/coach-metrics";
import { CoachPreferences, NO_PREFERENCES, derivePreferences } from "../analysis/recommendation-engine";
import { once, runStep } from "../orchestration/step-runner";

// The verified, user-scoped financial context for ONE Coach question.
//
// Scoping: a session is opened with the authenticated user's id and every read goes through an existing
// service method that takes that id. No method here accepts a user id, so nothing that arrives later (question
// text, retrieved documents, model output) can redirect a read to another user's records.
//
// Efficiency: each source is read at most once per session (memoised), and only when a handler asks for it,
// so a savings-rate question does not load loans, insurance or retirement.
//
// Honesty: every source returns a Sourced<T>. A failed or timed-out source is reported as failed (and ends up
// in the report's data gaps and engine status); it is never replaced with an empty list or a zero.

export type Sourced<T> = { ok: true; data: T } | { ok: false; reason: string };

export interface MonthData {
  month: string;
  status: MonthStatus;
  /** Income RECEIVED in the month, INR only. count 0 means nothing was recorded, which is not zero income. */
  income: RecordedAmount;
  incomeForeignCount: number;
  /** Genuine spending (EXPENSE flow, no SAVINGS-type categories, INR only). */
  spending: CategoryBreakdown;
  /** Every expense row in the month before classification, so "nothing recorded" can be told from "all excluded". */
  expenseRowCount: number;
}

type DebtSummary = Awaited<ReturnType<LoansService["debtSummary"]>>;
type InvestmentSummary = Awaited<ReturnType<InvestmentsService["summary"]>>;
type RetirementPlan = Awaited<ReturnType<RetirementService["computePlan"]>>;
type RetirementProfile = Awaited<ReturnType<RetirementService["getOrCreateProfile"]>>;
type EmergencyOverview = Awaited<ReturnType<EmergencyFundService["overview"]>>;
type Position = Awaited<ReturnType<FinancialFactsService["getFinancialPosition"]>>;
type Policies = Awaited<ReturnType<InsuranceService["list"]>>;
type Gaps = Awaited<ReturnType<InsuranceService["gapAnalysis"]>>;

export interface GoalsData {
  raw: GoalDTO[];
  assessed: GoalAssessment[];
}

export interface InsuranceData {
  policies: Policies;
  gaps: Gaps;
}

export class CoachDataSession {
  readonly engineNotes: { source: string; ok: boolean; reason?: string }[] = [];

  constructor(
    readonly userId: string,
    readonly now: Date,
    private readonly deps: {
      income: IncomeService;
      expenses: ExpensesService;
      loans: LoansService;
      goals: GoalsService;
      investments: InvestmentsService;
      insurance: InsuranceService;
      retirement: RetirementService;
      emergency: EmergencyFundService;
      facts: FinancialFactsService;
      memory: FinancialMemoryService;
    },
  ) {}

  private async load<T>(source: string, fn: () => Promise<T>): Promise<Sourced<T>> {
    const outcome = await runStep(source, fn);
    this.engineNotes.push({ source, ok: outcome.ok, reason: outcome.ok ? undefined : outcome.reason });
    return outcome.ok ? { ok: true, data: outcome.data } : { ok: false, reason: outcome.reason };
  }

  private readonly incomeRows = once(() => this.load("income records", () => this.deps.income.list(this.userId)));
  private readonly expenseRows = once(() => this.load("expense records", () => this.deps.expenses.list(this.userId)));

  /** One calendar month (UTC, the convention every FinancialFacts figure uses) of income and classified spending. */
  async month(month: string): Promise<Sourced<MonthData>> {
    const [incomes, expenses] = await Promise.all([this.incomeRows(), this.expenseRows()]);
    if (!incomes.ok) return { ok: false, reason: `income records unavailable (${incomes.reason})` };
    if (!expenses.ok) return { ok: false, reason: `expense records unavailable (${expenses.reason})` };

    const inMonth = (d: Date | string) => new Date(d).toISOString().slice(0, 7) === month;
    const incomeInMonth = incomes.data.filter((i) => inMonth(i.receivedAt));
    const inr = incomeInMonth.filter((i) => (i.currency ?? "INR").toUpperCase() === "INR");
    const expensesInMonth = expenses.data.filter((e) => inMonth(e.spentAt));

    return {
      ok: true,
      data: {
        month,
        status: monthStatus(month, this.now),
        income: recorded(inr.map((i) => i.amount as unknown as string | number)),
        incomeForeignCount: incomeInMonth.length - inr.length,
        spending: buildCategoryBreakdown(
          expensesInMonth.map((e) => ({
            amount: e.amount as unknown as string | number,
            currency: e.currency,
            categoryName: e.category.name,
            categoryType: e.category.type,
            flowType: e.flowType,
          })),
        ),
        expenseRowCount: expensesInMonth.length,
      },
    };
  }

  /** The user's own category names, taken from expenses they have actually recorded (never the shared category table). */
  async ownCategoryNames(): Promise<Sourced<string[]>> {
    const expenses = await this.expenseRows();
    if (!expenses.ok) return { ok: false, reason: expenses.reason };
    return { ok: true, data: [...new Set(expenses.data.map((e) => e.category.name))].sort() };
  }

  readonly position = once(() => this.load<Position>("financial position", () => this.deps.facts.getFinancialPosition(this.userId)));
  readonly emergency = once(() => this.load<EmergencyOverview>("emergency fund", () => this.deps.emergency.overview(this.userId, this.now)));
  readonly debt = once(() => this.load<DebtSummary>("loans", () => this.deps.loans.debtSummary(this.userId)));
  readonly investments = once(() => this.load<InvestmentSummary>("investments", () => this.deps.investments.summary(this.userId)));
  readonly retirement = once(() => this.load<RetirementPlan>("retirement plan", () => this.deps.retirement.computePlan(this.userId)));
  readonly retirementProfile = once(() => this.load<RetirementProfile>("retirement profile", () => this.deps.retirement.getOrCreateProfile(this.userId)));

  /** Existing amortisation-based prepayment impact for one of THIS user's loans (the service re-checks ownership). */
  async prepayment(loanId: string, lumpSum: number): Promise<Sourced<Awaited<ReturnType<LoansService["prepaymentImpact"]>>>> {
    return this.load("loan prepayment impact", () => this.deps.loans.prepaymentImpact(this.userId, loanId, lumpSum));
  }

  readonly goals = once(() =>
    this.load<GoalsData>("goals", async () => {
      const raw = await this.deps.goals.list(this.userId);
      return { raw, assessed: raw.map((g) => assessGoal(g, this.now)) };
    }),
  );

  readonly insurance = once(() =>
    this.load<InsuranceData>("insurance", async () => {
      const [policies, gaps] = await Promise.all([this.deps.insurance.list(this.userId), this.deps.insurance.gapAnalysis(this.userId)]);
      return { policies, gaps };
    }),
  );

  /** Standing constraints/preferences the user has stated. A failure means "none known", disclosed, not "none". */
  readonly preferences = once(() =>
    this.load<CoachPreferences>("saved preferences", async () => {
      const profile = await this.deps.memory.getOrCreate(this.userId);
      return derivePreferences([...profile.constraints.map((c) => c.text), ...profile.preferences.map((p) => `${p.key} ${p.value}`)]);
    }),
  );

  async preferencesOrNone(): Promise<CoachPreferences> {
    const p = await this.preferences();
    return p.ok ? p.data : NO_PREFERENCES;
  }

  /** The most recent complete month and the one before it (the comparable pair for trends). */
  completeMonths(count: number): string[] {
    const y = this.now.getUTCFullYear();
    const m = this.now.getUTCMonth();
    return Array.from({ length: count }, (_, i) => {
      const d = new Date(Date.UTC(y, m - (count - i), 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    });
  }

  currentMonth(): string {
    return this.now.toISOString().slice(0, 7);
  }
}

@Injectable()
export class CoachContextService {
  constructor(
    private income: IncomeService,
    private expenses: ExpensesService,
    private loans: LoansService,
    private goals: GoalsService,
    private investments: InvestmentsService,
    private insurance: InsuranceService,
    private retirement: RetirementService,
    private emergency: EmergencyFundService,
    private facts: FinancialFactsService,
    private memory: FinancialMemoryService,
  ) {}

  /** Opens a session bound to the authenticated user. `userId` must come from the session guard, never from request text. */
  open(userId: string, now: Date = new Date()): CoachDataSession {
    return new CoachDataSession(userId, now, {
      income: this.income,
      expenses: this.expenses,
      loans: this.loans,
      goals: this.goals,
      investments: this.investments,
      insurance: this.insurance,
      retirement: this.retirement,
      emergency: this.emergency,
      facts: this.facts,
      memory: this.memory,
    });
  }
}
