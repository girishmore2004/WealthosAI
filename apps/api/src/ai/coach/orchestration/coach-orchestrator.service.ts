import { Injectable, Logger } from "@nestjs/common";
import { CoachReportDTO, RunScenarioResponseDTO, ScenarioType } from "@wealthos/types";
import { LoansService } from "../../../loans/loans.service";
import { Dec, ZERO } from "../../../common/financial-facts/financial-formulas";
import { SimulatorService } from "../../../simulator/simulator.service";
import { ScenarioStudioService } from "../../scenario-studio/scenario-studio.service";
import { RagService } from "../../rag/rag.service";
import { CoachContextService, CoachDataSession, MonthData, Sourced } from "../context/coach-context.service";
import {
  DEFAULT_EMERGENCY_TARGET_MONTHS,
  HIGH_INTEREST_RATE_PERCENT,
  ILLUSTRATIVE_HOUSE_ASSUMPTIONS,
  MonthStatus,
  assessEmergencyFund,
  assessHousePurchase,
  compareCategories,
  computeSavingsRate,
  emiToIncomeRatio,
  matchCategories,
  monthsToReach,
  projectSip,
  requiredMonthlyContribution,
  round2,
  roundPct1,
  toDecimal,
} from "../analysis/coach-metrics";
import { CoachUnderstanding, understandCoachQuestion, primaryAmount } from "../analysis/question-understanding";
import { RecommendationFacts, buildRecommendations } from "../analysis/recommendation-engine";
import { ReportBuilder, cleanText, inr, pct, reportToFactsText, signedInr } from "../report/report-builder";
import { SCENARIO_TIMEOUT_MS, runStep } from "./step-runner";

// The Coach's orchestration layer. For a question it can type deterministically it:
//   1. opens ONE user-bound data session (verified context, read at most once per source),
//   2. calls the existing deterministic engines (metrics, Simulator, Scenario Studio, AI Search/RAG),
//   3. assembles a validated CoachReportDTO.
// It never calls a model. Wording by a model, if any, happens afterwards in AgenticCoachService and is
// numerically verified against `explanationFacts`. A question it does not recognise returns null and the
// existing Coach 2.0 pipeline answers it unchanged.
//
// Bounded: at most one RAG search and one Scenario Studio/Simulator run per question, each with a hard timeout.
// Safety: routing reads only the user's question; retrieved text is rendered as display data and can never add
// an execution action, change routing, or alter a number.

export interface OrchestratedAnswer {
  report: CoachReportDTO;
  /** Compact summary stored with the run (no raw records). */
  facts: Record<string, unknown>;
  /** The only text a model may word an explanation from; null when no model wording should be attempted. */
  explanationFacts: string | null;
  citedSources: string[];
  confidence: number;
  kind: string;
}

interface Ctx {
  s: CoachDataSession;
  b: ReportBuilder;
  u: CoachUnderstanding;
  question: string;
  userId: string;
  now: Date;
}

interface HandlerResult {
  answer: string;
  type: CoachReportDTO["answerType"];
  sufficiency: CoachReportDTO["evidenceSufficiency"];
  /** Allow model wording of an explanation (never for documents or clarifications). */
  explainable?: boolean;
  cited?: string[];
}

// Whatever LoansService.debtSummary actually returns, so this file never disagrees with the service about field types.
type LoanRow = Awaited<ReturnType<LoansService["debtSummary"]>>["loans"][number];

const ASSUMED_RETURN_FALLBACK_PERCENT = 10;
const ILLUSTRATIVE_PREPAY_UNIT = 100_000;
const ILLUSTRATIVE_EXTRA_MONTHLY = 5_000;
const ILLUSTRATIVE_SAVINGS_RETURN_PERCENT = 7;
const RAG_MIN_GROUNDING = 0.6;

const sum = (xs: Dec[]): Dec => xs.reduce((a, x) => a.plus(x), ZERO);
const num = (v: unknown): number => Number(v);

@Injectable()
export class CoachOrchestratorService {
  private readonly logger = new Logger(CoachOrchestratorService.name);

  constructor(
    private context: CoachContextService,
    private simulator: SimulatorService,
    private studio: ScenarioStudioService,
    private rag: RagService,
  ) {}

  /** Returns null when the question is not one this layer handles (the caller then uses the existing pipeline). */
  async tryHandle(userId: string, question: string, now: Date = new Date()): Promise<OrchestratedAnswer | null> {
    const u = understandCoachQuestion(question, now);
    if (u.kind === "defer") return null;

    const b = new ReportBuilder(now);
    const s = this.context.open(userId, now);
    const ctx: Ctx = { s, b, u, question, userId, now };

    let result: HandlerResult;
    try {
      result = await this.dispatch(ctx);
    } catch (err) {
      // A handler bug or an unexpected failure must not become a 500 or a fabricated answer.
      this.logger.warn(`Coach orchestration failed for kind "${u.kind}": ${err instanceof Error ? err.name : "error"}`);
      b.partial = true;
      b.gap("ORCHESTRATION_FAILED", "Part of the analysis could not be completed.", "Nothing was estimated in its place.");
      result = { answer: "I couldn't complete that analysis just now, and I don't want to guess at your numbers. Please try again in a moment.", type: "fact", sufficiency: "insufficient" };
    }

    b.noteSessionFailures(s.engineNotes);
    const report = b.build({ directAnswer: result.answer, answerType: result.type, sufficiency: result.sufficiency });
    const confidence = report.evidenceSufficiency === "sufficient" ? 0.95 : report.evidenceSufficiency === "partial" ? 0.7 : 0.4;
    return {
      report,
      // Key figures only (no raw records). They make "has your data changed since last time?" meaningful.
      facts: {
        kind: u.kind,
        evidenceSufficiency: report.evidenceSufficiency,
        partial: report.metadata.partial,
        values: report.financialSnapshot.items.map((i) => [i.key, i.value]),
        results: report.calculations.map((k) => [k.id, k.result]),
      },
      explanationFacts: result.explainable === false || report.evidenceSufficiency === "insufficient" ? null : reportToFactsText(report),
      citedSources: result.cited ?? [],
      confidence,
      kind: u.kind,
    };
  }

  private dispatch(c: Ctx): Promise<HandlerResult> {
    switch (c.u.kind) {
      case "savings_rate":
        return this.savingsRate(c);
      case "category_spend":
        return this.categorySpend(c);
      case "top_categories":
        return this.topCategories(c);
      case "emergency_fund":
        return this.emergencyFund(c);
      case "retirement_on_track":
        return this.retirementOnTrack(c);
      case "financial_health":
        return this.financialHealth(c);
      case "what_if":
        return this.whatIf(c);
      case "house_affordability":
        return this.house(c, c.u.house!.price, c.u.house);
      case "prepay_vs_sip":
        return this.prepayVsSip(c);
      case "goal_acceleration":
        return this.goalAcceleration(c);
      case "savings_plan":
        return this.savingsPlan(c);
      case "insurance_document":
      case "document":
        return this.documents(c);
      case "clarification":
        return Promise.resolve(this.clarify(c, c.u.clarification ?? "Could you tell me a little more about what you'd like to know?"));
      default:
        return Promise.resolve(this.clarify(c, "Could you rephrase that?"));
    }
  }

  private followHealth(b: ReportBuilder): void {
    b.followUp("Am I financially healthy?");
    b.followUp("What if I increase my SIP by \u20B95,000?");
  }

  private clarify(c: Ctx, question: string): HandlerResult {
    c.b.engine("calculations", "skipped", "Waiting for more information");
    return { answer: question, type: "clarification", sufficiency: "insufficient", explainable: false };
  }

  // --- shared loaders --------------------------------------------------------------------------------

  private async months(c: Ctx, months: string[]): Promise<Sourced<MonthData[]>> {
    const all = await Promise.all(months.map((m) => c.s.month(m)));
    const failed = all.find((m) => !m.ok);
    if (failed && !failed.ok) return { ok: false, reason: failed.reason };
    return { ok: true, data: all.map((m) => (m as { ok: true; data: MonthData }).data) };
  }

  private combinedStatus(ms: MonthData[]): MonthStatus {
    const last = ms[ms.length - 1].status;
    return {
      month: last.month,
      complete: ms.every((m) => m.status.complete),
      isFuture: ms.every((m) => m.status.isFuture),
      daysElapsed: last.daysElapsed,
      daysInMonth: last.daysInMonth,
    };
  }

  private merge(ms: MonthData[]) {
    const incomeAmount = sum(ms.map((m) => m.income.amount));
    const incomeCount = ms.reduce((a, m) => a + m.income.count, 0);
    const spendTotal = sum(ms.map((m) => m.spending.total));
    const spendCount = ms.reduce((a, m) => a + m.spending.count, 0);
    const byCategory = new Map<string, Dec>();
    for (const m of ms) for (const cat of m.spending.categories) byCategory.set(cat.name, (byCategory.get(cat.name) ?? ZERO).plus(cat.total));
    return { incomeAmount, incomeCount, spendTotal, spendCount, byCategory };
  }

  private noteExclusions(c: Ctx, ms: MonthData[]): void {
    const savingsCount = ms.reduce((a, m) => a + m.spending.excluded.savingsCount, 0);
    if (savingsCount > 0) {
      const total = sum(ms.map((m) => m.spending.excluded.savingsTotal));
      c.b.assume(`${savingsCount} expense row(s) in savings-type categories (${inr(round2(total))}) are cash set aside, not spending, so they are not counted as spending.`);
    }
    const foreign = ms.reduce((a, m) => a + m.spending.excluded.foreignCurrency.reduce((x, f) => x + f.count, 0), 0) + ms.reduce((a, m) => a + m.incomeForeignCount, 0);
    if (foreign > 0) {
      c.b.gap("FOREIGN_CURRENCY", `${foreign} record(s) are in a currency other than INR.`, "They are left out of rupee totals rather than converted at a guessed rate.");
      c.b.partial = true;
    }
  }

  /** Last complete month's income/spending as plain numbers; null means not recorded (never zero). */
  private async lastCompleteBasis(c: Ctx) {
    const month = c.s.completeMonths(1)[0];
    const m = await c.s.month(month);
    if (!m.ok) return { month, income: null as number | null, spending: null as number | null, data: null as MonthData | null };
    return {
      month,
      income: m.data.income.count > 0 ? round2(m.data.income.amount) : null,
      spending: m.data.spending.count > 0 ? round2(m.data.spending.total) : null,
      data: m.data,
    };
  }

  private async emergencyAssessment(c: Ctx) {
    const ov = await c.s.emergency();
    if (!ov.ok) return null;
    const monthsOfData = ov.data.coverage.monthsOfData;
    const a = assessEmergencyFund({
      balance: ov.data.balance,
      avgMonthlyEssential: monthsOfData > 0 ? ov.data.coverage.avgMonthlyEssentialExpenses : null,
      monthsOfData,
      userTargetAmount: ov.data.target.amount,
      userTargetMonths: ov.data.target.amount === null ? ov.data.target.months : null,
    });
    return a;
  }

  // --- facts: savings rate / categories --------------------------------------------------------------

  private async savingsRate(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const period = c.u.period ?? { months: [s.currentMonth()], label: `this month so far (${s.currentMonth()})`, assumed: true };
    const loaded = await this.months(c, period.months);
    if (!loaded.ok) {
      b.gap("SOURCE_UNAVAILABLE", `Income or expense records could not be read (${loaded.reason}).`, "No savings rate can be calculated without them.");
      return { answer: "I couldn't read your income and expense records just now, so I can't calculate a savings rate without guessing.", type: "fact", sufficiency: "insufficient" };
    }
    const ms = loaded.data;
    const m = this.merge(ms);
    const status = this.combinedStatus(ms);
    const r = computeSavingsRate({ amount: m.incomeAmount, count: m.incomeCount }, { amount: m.spendTotal, count: m.spendCount }, status);
    this.noteExclusions(c, ms);
    b.assume("Savings rate = (income received − genuine spending) ÷ income received. Genuine spending excludes investments, emergency-fund set-asides and transfers.");

    if (r.rate === null) {
      const why =
        r.reason === "NO_INCOME_RECORDED"
          ? `no income is recorded for ${period.label}`
          : r.reason === "NO_EXPENSES_RECORDED"
            ? `no expenses are recorded for ${period.label} (so spending is unknown, not zero)`
            : `${period.label} has not started yet`;
      b.gap(r.reason ?? "NOT_COMPUTABLE", `Savings rate for ${period.label}: ${why}.`, "A rate would be a guess, so none is shown.");
      b.money("income", "Income received", r.reason === "NO_INCOME_RECORDED" ? null : round2(m.incomeAmount));
      b.money("spending", "Spending", m.spendCount === 0 ? null : round2(m.spendTotal));
      b.followUp("What are my top spending categories this month?");
      return { answer: `I can't calculate your savings rate for ${period.label}: ${why}. Add the missing records and I'll work it out.`, type: "fact", sufficiency: "insufficient" };
    }

    const rate = roundPct1(r.rate);
    const netSaved = round2(r.netSaved!);
    b.money("income", "Income received", round2(r.income!));
    b.money("spending", "Spending", round2(r.spending!));
    b.money("net-saved", "Net saved", netSaved);
    b.item("savings-rate", "Savings rate", rate, pct(rate), "%", r.estimate ? "estimate" : "verified");
    b.calculations.push({
      id: "savings-rate",
      label: "Savings rate",
      formula: "(income received − genuine spending) ÷ income received × 100",
      inputs: [
        { label: "Income received", value: inr(round2(r.income!)) },
        { label: "Genuine spending", value: inr(round2(r.spending!)) },
      ],
      result: rate,
      display: pct(rate),
      unit: "%",
      period: period.label,
      assumptions: r.estimate ? ["The period is not finished: income received so far is compared with spending so far."] : [],
      quality: r.estimate ? "estimate" : "verified",
    });
    b.finding(`${netSaved >= 0 ? "Saved" : "Overspent by"} ${inr(Math.abs(netSaved))} of ${inr(round2(r.income!))} income.`, netSaved >= 0 ? (rate >= 20 ? "good" : "info") : "bad");
    if (r.estimate) {
      b.risk("This period is still running, so the rate is an estimate and is not comparable with a complete month.");
      b.partial = true;
    }
    b.charts.push({ id: "income-vs-spending", kind: "bar", title: `Income vs spending, ${period.label}`, unit: "INR", xKey: "name", series: [{ key: "amount", label: "Amount" }], data: [{ name: "Income", amount: round2(r.income!) }, { name: "Spending", amount: round2(r.spending!) }], source: "Your recorded income and expenses" });

    // When the current (unfinished) month was assumed, also give the last complete month so the answer is comparable.
    let extra = "";
    if (period.assumed && r.estimate) {
      const prev = s.completeMonths(1)[0];
      const pm = await s.month(prev);
      if (pm.ok) {
        const pr = computeSavingsRate(pm.data.income, { amount: pm.data.spending.total, count: pm.data.spending.count }, pm.data.status);
        if (pr.rate !== null) {
          extra = ` Last complete month (${prev}) was ${roundPct1(pr.rate)}%.`;
          b.item("savings-rate-prev", `Savings rate, ${prev}`, roundPct1(pr.rate), pct(roundPct1(pr.rate)), "%", "verified");
        }
      }
    }
    b.followUp("Where did most of my money go this month?");
    b.followUp("Am I financially healthy?");
    b.open("Open Expenses", "/money/expenses", "See and edit the underlying expense records.");
    return {
      answer: `Your savings rate for ${period.label} is ${rate}% (saved ${inr(netSaved)} of ${inr(round2(r.income!))} income).${r.estimate ? " The month isn't over, so treat this as an estimate." : ""}${extra}`,
      type: "fact",
      sufficiency: r.estimate ? "partial" : "sufficient",
      explainable: true,
    };
  }

  private async categorySpend(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const hint = c.u.categoryHint!;
    const period = c.u.period!;
    const [loaded, names] = await Promise.all([this.months(c, period.months), s.ownCategoryNames()]);
    if (!loaded.ok || !names.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Expense records could not be read.", "No category total can be calculated without them.");
      return { answer: "I couldn't read your expense records just now, so I can't total that category without guessing.", type: "fact", sufficiency: "insufficient" };
    }
    const matched = matchCategories(hint, names.data);
    this.noteExclusions(c, loaded.data);
    if (matched.length === 0) {
      b.gap("NO_SUCH_CATEGORY", `None of your recorded expenses are in a category matching "${hint}".`, "No total is shown: absence of a category is not the same as zero spending.");
      b.assume("Categories are taken from the expenses you have actually recorded.");
      if (names.data.length) b.finding(`Categories you have used: ${names.data.slice(0, 12).join(", ")}.`, "info");
      b.followUp("What are my top spending categories this month?");
      return { answer: `I couldn't find a category matching "${hint}" in your recorded expenses${names.data.length ? ` (your categories include ${names.data.slice(0, 6).join(", ")})` : ""}, so I won't give a figure.`, type: "fact", sufficiency: "insufficient" };
    }

    const perMonth = loaded.data.map((m) => ({ month: m.month, total: sum(m.spending.categories.filter((x) => matched.includes(x.name)).map((x) => x.total)), rows: m.spending.categories.filter((x) => matched.includes(x.name)).reduce((a, x) => a + x.count, 0), expenseRows: m.expenseRowCount, status: m.status }));
    const total = sum(perMonth.map((p) => p.total));
    const rows = perMonth.reduce((a, p) => a + p.rows, 0);
    const label = matched.join(" + ");
    const incomplete = perMonth.some((p) => !p.status.complete);

    b.money("category-total", `${label} spending`, rows === 0 ? null : round2(total), incomplete ? "incomplete_period" : "verified");
    b.calculations.push({
      id: "category-total",
      label: `Spending in ${label}`,
      formula: "sum of recorded expense amounts in the matched categories for the period",
      inputs: [{ label: "Categories matched", value: matched.join(", ") }, { label: "Period", value: period.label }, { label: "Records", value: String(rows) }],
      result: rows === 0 ? null : round2(total),
      display: rows === 0 ? "No records" : inr(round2(total)),
      unit: "INR",
      period: period.label,
      assumptions: [`"${hint}" was matched to your own categories: ${matched.join(", ")}.`],
      quality: rows === 0 ? "empty" : incomplete ? "incomplete_period" : "verified",
    });
    for (const p of perMonth) {
      b.evidence.push({ id: `cat-${p.month}`, sourceType: "Expenses", sourceName: label, period: p.month, value: inr(round2(p.total)), calculationBasis: `${p.rows} recorded expense(s)`, quality: p.rows === 0 ? "empty" : p.status.complete ? "verified" : "incomplete_period" });
    }
    b.charts.push({ id: "category-by-month", kind: "bar", title: `${label} spending by month`, unit: "INR", xKey: "month", series: [{ key: "amount", label: label }], data: perMonth.map((p) => ({ month: p.month, amount: p.rows === 0 && p.expenseRows === 0 ? null : round2(p.total) })), source: "Your recorded expenses" });

    // Comparison with the previous month, only when both are complete months.
    let compare = "";
    if (period.months.length === 1 && perMonth[0].status.complete) {
      const [y, mo] = period.months[0].split("-").map(Number);
      const prevMonth = `${new Date(Date.UTC(y, mo - 2, 1)).getUTCFullYear()}-${String(new Date(Date.UTC(y, mo - 2, 1)).getUTCMonth() + 1).padStart(2, "0")}`;
      const prev = await s.month(prevMonth);
      if (prev.ok && prev.data.spending.count > 0) {
        const pt = sum(prev.data.spending.categories.filter((x) => matched.includes(x.name)).map((x) => x.total));
        const diff = total.minus(pt);
        compare = ` That is ${diff.gte(0) ? "up" : "down"} ${inr(Math.abs(round2(diff)))} from ${prevMonth} (${inr(round2(pt))}).`;
        b.finding(`${diff.gte(0) ? "Up" : "Down"} ${inr(Math.abs(round2(diff)))} vs ${prevMonth}.`, diff.gt(0) ? "warn" : "good");
      }
    }
    if (incomplete) {
      b.risk("The period includes a month that is not over, so the total may still grow.");
      b.partial = true;
    }
    b.followUp("What are my top spending categories?");
    b.open("Open Expenses", "/money/expenses", "See the individual expense records.");
    if (rows === 0) {
      b.gap("NO_RECORDS", `No expenses are recorded in ${label} for ${period.label}.`, "This is shown as no records, not as ₹0 spent.");
      return { answer: `I found the category ${label}, but there are no expenses recorded in it for ${period.label}. I can't tell whether you spent nothing or just haven't logged it.`, type: "fact", sufficiency: "partial" };
    }
    return { answer: `You spent ${inr(round2(total))} on ${label} in ${period.label}.${compare}${incomplete ? " The period isn't over yet, so this may grow." : ""}`, type: "fact", sufficiency: incomplete ? "partial" : "sufficient", explainable: true };
  }

  private async topCategories(c: Ctx): Promise<HandlerResult> {
    const { b } = c;
    const period = c.u.period!;
    const loaded = await this.months(c, period.months);
    if (!loaded.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Expense records could not be read.", "No category ranking can be shown.");
      return { answer: "I couldn't read your expense records just now, so I can't rank your categories without guessing.", type: "fact", sufficiency: "insufficient" };
    }
    this.noteExclusions(c, loaded.data);
    const m = this.merge(loaded.data);
    if (m.spendCount === 0) {
      b.gap("NO_EXPENSES_RECORDED", `No expenses are recorded for ${period.label}.`, "There is nothing to rank.");
      return { answer: `There are no expenses recorded for ${period.label}, so I can't rank categories.`, type: "fact", sufficiency: "insufficient" };
    }
    const ranked = [...m.byCategory.entries()].sort((x, y) => y[1].comparedTo(x[1]) || x[0].localeCompare(y[0])).slice(0, 8);
    const incomplete = loaded.data.some((x) => !x.status.complete);
    ranked.forEach(([name, total], i) => b.item(`cat-${i + 1}`, name, round2(total), `${inr(round2(total))} (${roundPct1(total.div(m.spendTotal))}%)`, "INR", incomplete ? "incomplete_period" : "verified"));
    b.money("spending-total", "Total spending", round2(m.spendTotal), incomplete ? "incomplete_period" : "verified");
    b.calculations.push({ id: "category-share", label: "Share of spending", formula: "category total ÷ total genuine spending × 100", inputs: [{ label: "Total spending", value: inr(round2(m.spendTotal)) }, { label: "Period", value: period.label }], result: null, display: "See snapshot", unit: "%", period: period.label, assumptions: [], quality: incomplete ? "incomplete_period" : "verified" });
    b.charts.push({ id: "top-categories", kind: "bar", title: `Top categories, ${period.label}`, unit: "INR", xKey: "name", series: [{ key: "amount", label: "Spending" }], data: ranked.map(([name, total]) => ({ name, amount: round2(total) })), source: "Your recorded expenses" });
    const [topName, topTotal] = ranked[0];
    b.finding(`${topName} is your largest category at ${roundPct1(topTotal.div(m.spendTotal))}% of spending.`, "info");
    if (incomplete) {
      b.risk("The period is not over, so rankings may change.");
      b.partial = true;
    }
    b.followUp(`How much did I spend on ${topName.toLowerCase()} last month?`);
    b.open("Open Expenses", "/money/expenses", "See the individual expense records.");
    const list = ranked.slice(0, 3).map(([n, t]) => `${n} (${inr(round2(t))})`).join(", ");
    return { answer: `Your top spending categories for ${period.label}: ${list}. Total spending was ${inr(round2(m.spendTotal))}.${incomplete ? " The period isn't over yet." : ""}`, type: "fact", sufficiency: incomplete ? "partial" : "sufficient", explainable: true };
  }

  // --- health -------------------------------------------------------------------------------------------

  private async emergencyFund(c: Ctx): Promise<HandlerResult> {
    const { b } = c;
    const a = await this.emergencyAssessment(c);
    if (!a) {
      b.gap("SOURCE_UNAVAILABLE", "Emergency-fund data could not be read.", "Coverage cannot be assessed.");
      return { answer: "I couldn't read your emergency-fund data just now, so I can't judge whether it is adequate.", type: "health", sufficiency: "insufficient" };
    }
    const bal = round2(a.balance);
    b.money("emergency-balance", "Emergency fund balance", bal);
    if (a.coverageMonths === null || a.avgMonthlyEssential === null) {
      b.gap("NO_ESSENTIAL_SPEND_HISTORY", "There is no history of essential (need) expenses to measure coverage against.", "Months of coverage cannot be calculated; mark expenses as needs to enable it.");
      this.followHealth(b);
      return { answer: `Your emergency fund holds ${inr(bal)}, but I can't say how many months that covers because there's no essential-expense history yet.`, type: "health", sufficiency: "partial" };
    }
    const cov = round2(a.coverageMonths);
    const target = a.targetMonths ? round2(a.targetMonths) : DEFAULT_EMERGENCY_TARGET_MONTHS;
    b.item("coverage", "Coverage", cov, `${cov} months`, "months", "verified");
    b.money("avg-essential", "Average monthly essential spending", round2(a.avgMonthlyEssential), "verified", `Over ${a.monthsOfData} month(s) of data`);
    if (a.targetAmount) b.money("target", "Target", round2(a.targetAmount), a.targetIsDefault ? "estimate" : "verified");
    if (a.shortfall) b.money("shortfall", "Shortfall to target", round2(a.shortfall));
    b.calculations.push({
      id: "emergency-coverage",
      label: "Emergency coverage",
      formula: "emergency fund balance ÷ average monthly essential expenses",
      inputs: [{ label: "Balance", value: inr(bal) }, { label: "Avg monthly essential spending", value: inr(round2(a.avgMonthlyEssential)) }],
      result: cov,
      display: `${cov} months`,
      unit: "months",
      assumptions: a.targetIsDefault ? [`No target is set, so a ${DEFAULT_EMERGENCY_TARGET_MONTHS}-month target is assumed.`] : [],
      quality: "verified",
    });
    if (a.targetIsDefault) b.assume(`No emergency target is set; ${DEFAULT_EMERGENCY_TARGET_MONTHS} months of essential spending is used as a default.`);
    b.charts.push({ id: "emergency-coverage-chart", kind: "bar", title: "Emergency coverage (months)", unit: "months", xKey: "name", series: [{ key: "months", label: "Months" }], data: [{ name: "Current", months: cov }, { name: "Target", months: target }], source: "Emergency fund and essential-expense records" });
    const verdictText = a.verdict === "adequate" ? "meets" : a.verdict === "partial" ? "is part-way to" : "is well below";
    b.finding(`Coverage ${verdictText} the ${target}-month target.`, a.verdict === "adequate" ? "good" : a.verdict === "partial" ? "warn" : "bad");
    if (a.verdict !== "adequate") b.risk("A job loss or large bill could force borrowing or selling investments.");
    b.open("Open Emergency Fund", "/money/emergency-fund", "Set or adjust your target and contributions.");
    this.followHealth(b);
    return {
      answer: `Your emergency fund of ${inr(bal)} covers about ${cov} months of essential spending, which ${verdictText} the ${target}-month target${a.shortfall && a.shortfall.gt(0) ? ` (${inr(round2(a.shortfall))} short)` : ""}.`,
      type: "health",
      sufficiency: "sufficient",
      explainable: true,
    };
  }

  private async retirementOnTrack(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const [plan, profile] = await Promise.all([s.retirement(), s.retirementProfile()]);
    if (!plan.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Retirement plan could not be computed.", "On-track status cannot be assessed.");
      return { answer: "I couldn't compute your retirement plan just now, so I can't say whether you're on track.", type: "health", sufficiency: "insufficient" };
    }
    const p = plan.data;
    const required = round2(toDecimal(p.corpusRequired));
    const current = round2(toDecimal(p.currentRetirementCorpus));
    const gap = round2(toDecimal(p.corpusGap));
    const sip = round2(toDecimal(p.requiredMonthlySip));
    b.money("corpus-required", "Corpus required", required, "estimate");
    b.money("corpus-current", "Current retirement corpus", current);
    b.money("corpus-gap", "Gap", gap, "estimate");
    b.money("required-sip", "Monthly SIP needed to close the gap", sip, "estimate");
    b.item("years", "Years to retirement", p.yearsToRetirement, `${p.yearsToRetirement} years`, "count", "verified");
    b.calculations.push({
      id: "retirement-gap",
      label: "Retirement corpus gap",
      formula: "corpus required (present value of post-retirement income) − current retirement corpus",
      inputs: [{ label: "Corpus required", value: inr(required) }, { label: "Current corpus", value: inr(current) }],
      result: gap,
      display: inr(gap),
      unit: "INR",
      assumptions: [p.isHorizonFromLifeExpectancy ? `Drawdown horizon of ${p.drawdownHorizonYears} years is based on your life expectancy.` : `A standard ${p.drawdownHorizonYears}-year drawdown horizon is assumed.`],
      quality: "estimate",
    });
    b.assume(p.isHorizonFromLifeExpectancy ? `Post-retirement horizon of ${p.drawdownHorizonYears} years comes from your stated life expectancy.` : `Post-retirement horizon of ${p.drawdownHorizonYears} years is a standard assumption; set your life expectancy for a better figure.`);
    if (profile.ok) b.assume(`Return before retirement: ${num(profile.data.expectedReturnPreRetirementPercent)}%, inflation ${num(profile.data.inflationRatePercent)}% (from your retirement profile).`);
    b.risk("Retirement figures are projections, not guarantees; markets and inflation vary.");
    b.charts.push({ id: "retirement-corpus", kind: "bar", title: "Retirement corpus", unit: "INR", xKey: "name", series: [{ key: "amount", label: "Amount" }], data: [{ name: "Current", amount: current }, { name: "Required", amount: required }], source: "Retirement plan" });
    b.finding(p.onTrack ? "Your current corpus and contributions are on track." : `There is a ${inr(gap)} corpus gap.`, p.onTrack ? "good" : "warn");
    if (!p.onTrack) b.step("Review the retirement plan", `Closing the gap needs about ${inr(sip)} a month of extra investing.`, { href: "/money/retirement" });
    b.open("Open Retirement", "/money/retirement", "Adjust age, income need and return assumptions.");
    b.followUp("What if I increase my SIP by ₹5,000?");
    return {
      answer: p.onTrack ? `You are on track for retirement: your current corpus of ${inr(current)} meets the projected requirement of ${inr(required)}.` : `You are not yet on track: you need about ${inr(required)} and have ${inr(current)}, a gap of ${inr(gap)}. Closing it would take roughly ${inr(sip)} a month.`,
      type: "health",
      sufficiency: "sufficient",
      explainable: true,
    };
  }

  private async financialHealth(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const basis = await this.lastCompleteBasis(c);
    const [debt, goals, retirement, insurance, prefs, emergency, pairLoaded] = await Promise.all([
      s.debt(),
      s.goals(),
      s.retirement(),
      s.insurance(),
      s.preferencesOrNone(),
      this.emergencyAssessment(c),
      this.months(c, s.completeMonths(2)),
    ]);

    const emi = debt.ok ? round2(toDecimal(debt.data.totalMonthlyEmi)) : null;
    const surplus = basis.income !== null && basis.spending !== null && emi !== null ? round2(toDecimal(basis.income).minus(basis.spending).minus(emi)) : null;
    b.money("income", `Income, ${basis.month}`, basis.income);
    b.money("spending", `Spending, ${basis.month}`, basis.spending);
    b.money("emi", "Monthly EMIs", emi);
    b.money("surplus", "Monthly surplus after EMIs", surplus);
    if (basis.income === null) b.gap("NO_INCOME_RECORDED", `No income is recorded for ${basis.month}.`, "Savings rate, EMI load and surplus cannot be judged.");
    if (basis.spending === null) b.gap("NO_EXPENSES_RECORDED", `No expenses are recorded for ${basis.month}.`, "Surplus cannot be judged; spending is unknown, not zero.");
    b.assume("Surplus = income − spending − loan EMIs for the last complete month. EMIs are assumed not to be already recorded as expenses.");

    const sr = basis.income !== null && basis.spending !== null ? roundPct1(toDecimal(basis.income).minus(basis.spending).div(basis.income)) : null;
    if (sr !== null) b.item("savings-rate", "Savings rate", sr, pct(sr), "%", "verified");

    if (emergency) {
      b.item("coverage", "Emergency coverage", emergency.coverageMonths ? round2(emergency.coverageMonths) : null, emergency.coverageMonths ? `${round2(emergency.coverageMonths)} months` : "Not available", "months", emergency.coverageMonths ? "verified" : "missing");
    }
    const emiRatio = emiToIncomeRatio(emi ?? 0, basis.income);
    if (emiRatio && emi !== null) b.item("emi-ratio", "EMI to income", roundPct1(emiRatio), pct(roundPct1(emiRatio)), "%", "verified");

    const categoryIncreases: RecommendationFacts["categoryIncreases"] = [];
    if (pairLoaded.ok && pairLoaded.data.every((m) => m.spending.count > 0)) {
      const [older, newer] = pairLoaded.data;
      for (const ch of compareCategories(newer.spending, older.spending)) {
        if (ch.significant && ch.change.gt(0)) categoryIncreases.push({ name: ch.name, monthlyIncrease: round2(ch.change), ratio: ch.changeRatio ? Number(ch.changeRatio.toFixed(3)) : null });
      }
    }

    const facts: RecommendationFacts = {
      monthlyIncome: basis.income,
      monthlySpending: basis.spending,
      monthlySurplus: surplus,
      emergency: {
        verdict: emergency?.verdict ?? "unknown",
        shortfall: emergency?.shortfall ? round2(emergency.shortfall) : null,
        coverageMonths: emergency?.coverageMonths ? round2(emergency.coverageMonths) : null,
        targetMonths: emergency?.targetMonths ? round2(emergency.targetMonths) : null,
        targetIsDefault: emergency?.targetIsDefault ?? false,
      },
      loans: debt.ok ? debt.data.loans.map((l) => ({ id: l.id, lender: l.lender, type: String(l.type), ratePercent: num(l.interestRateAnnual), outstanding: num(l.outstandingPrincipal), emi: num(l.emiAmount) })) : [],
      emiToIncome: emiRatio ? Number(emiRatio.toFixed(4)) : null,
      goals: goals.ok ? goals.data.assessed : [],
      retirement: retirement.ok ? { onTrack: retirement.data.onTrack, corpusGap: num(retirement.data.corpusGap), requiredMonthlySip: num(retirement.data.requiredMonthlySip), yearsToRetirement: retirement.data.yearsToRetirement } : null,
      insuranceGaps: insurance.ok ? insurance.data.gaps.map((g) => ({ type: String(g.type), gap: num(g.gap), hasCoverage: g.hasCoverage })) : [],
      categoryIncreases,
      preferences: prefs,
    };
    const ranked = buildRecommendations(facts, 5);
    b.recommendations = ranked.recommendations;
    for (const sup of ranked.suppressed) b.assume(`Not suggested: ${sup}`);
    ranked.recommendations.slice(0, 5).forEach((r, i) => b.step(r.title, r.nextStep, { href: r.destination?.href, timeframe: r.priority.level === "urgent" ? "Now" : r.priority.level === "high" ? "This month" : "Next 1–3 months" }));
    for (const r of ranked.recommendations.filter((x) => x.priority.level === "urgent" || x.priority.level === "high")) b.risk(r.issue);

    const goalAssess = goals.ok ? goals.data.assessed : [];
    const behind = goalAssess.filter((g) => g.state === "ACTIVE" && !g.onTrack).length;
    const overdue = goalAssess.filter((g) => g.state === "OVERDUE").length;
    if (goals.ok) b.item("goals", "Goals behind pace", behind, `${behind} of ${goalAssess.filter((g) => g.state === "ACTIVE").length} active`, "count", "verified", overdue ? `${overdue} overdue` : undefined);
    if (goals.ok && goalAssess.some((g) => g.staleRequirement)) b.gap("STALE_GOAL_REQUIREMENT", "A funded goal still shows a monthly requirement.", "It is ignored; funded goals need nothing more.");

    const missing = [basis.income === null, basis.spending === null, !debt.ok, !emergency, !goals.ok, !retirement.ok].filter(Boolean).length;
    if (missing > 0) b.partial = true;
    for (const rec of ranked.recommendations.slice(0, 3)) b.finding(rec.title, rec.priority.level === "urgent" ? "bad" : rec.priority.level === "high" ? "warn" : "info");
    if (ranked.recommendations.length === 0) b.finding("No urgent issues found in the data that is recorded.", "good");
    b.followUp("How is my emergency fund?");
    b.followUp("Am I on track for retirement?");
    b.followUp("What if I increase my SIP by ₹5,000?");

    const lead = ranked.recommendations[0];
    const answer = lead
      ? `Based on what's recorded, your top priority is: ${lead.title}. ${lead.issue}${missing > 0 ? " Some data is missing, so this picture is partial." : ""}`
      : `Nothing urgent stands out in the data that is recorded.${missing > 0 ? " Some data is missing, so this picture is partial." : ""}`;
    return { answer, type: "health", sufficiency: missing === 0 ? "sufficient" : missing >= 4 ? "insufficient" : "partial", explainable: true };
  }

  // --- what-if ------------------------------------------------------------------------------------------

  private rows(run: RunScenarioResponseDTO) {
    const cf = num(run.result.monthlyCashflowDelta);
    const nwDelta = num(run.result.netWorthDeltaIn5Years);
    const nwProj = num(run.result.projectedNetWorthIn5Years);
    const base = nwProj - nwDelta;
    const dir = (n: number): "better" | "worse" | "neutral" => (n > 0 ? "better" : n < 0 ? "worse" : "neutral");
    return {
      cf,
      nwDelta,
      nwProj,
      base,
      rows: [
        { metric: "Monthly cash flow", baseline: "No change", proposed: signedInr(cf), delta: signedInr(cf), direction: dir(cf) },
        { metric: "Net worth in 5 years", baseline: inr(base), proposed: inr(nwProj), delta: signedInr(nwDelta), direction: dir(nwDelta) },
      ],
    };
  }

  private applyRun(c: Ctx, type: string, label: string, params: Record<string, number | string>, run: RunScenarioResponseDTO, source: "simulator" | "scenario_studio", narrative?: string) {
    const r = this.rows(run);
    c.b.scenario = { scenarioType: type, label, params, rows: r.rows, source, ...(narrative ? { narrative: cleanText(narrative, 1500) } : {}), assumptions: run.result.assumptions.map((a) => cleanText(a, 300)) };
    c.b.charts.push({ id: "scenario-networth", kind: "bar", title: "Projected net worth in 5 years", unit: "INR", xKey: "name", series: [{ key: "amount", label: "Net worth" }], data: [{ name: "Baseline", amount: round2(toDecimal(r.base)) }, { name: "With change", amount: round2(toDecimal(r.nwProj)) }], note: "Projection only, not a guarantee.", source: source === "simulator" ? "Simulator" : "Scenario Studio" });
    c.b.risk("Scenario results are projections based on stated assumptions, not guarantees.");
    return r;
  }

  private scenarioStudioAction(c: Ctx) {
    c.b.actions.push({ id: "open-studio", kind: "OPEN_SCENARIO_STUDIO", label: "Explore in Scenario Studio", description: "Open this question in Scenario Studio to compare best/base/worst variants and adjust inputs.", href: `/scenario-studio?prompt=${encodeURIComponent(c.question.slice(0, 300))}`, requiresConfirmation: false });
  }

  private async whatIf(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const spec = c.u.whatIf!;
    if (spec.type === "HOUSE_PURCHASE" && spec.amount) return this.house(c, spec.amount, undefined);
    if (spec.type === "LOAN_PREPAYMENT") return this.prepayScenario(c, spec.amount, spec.loanHint);

    // Typed what-ifs whose parameters are fully stated can run on the Simulator directly if Scenario Studio fails.
    const direct: { type: ScenarioType; params: Record<string, number> } | null =
      spec.type === "SIP_INCREASE" && spec.amount ? { type: "SIP_INCREASE", params: { additionalMonthlyAmount: spec.amount } }
      : spec.type === "SIP_DECREASE" && spec.amount ? { type: "SIP_DECREASE", params: { reducedMonthlyAmount: spec.amount } }
      : spec.type === "EMERGENCY_EXPENSE" && spec.amount ? { type: "EMERGENCY_EXPENSE", params: { amount: spec.amount } }
      : spec.type === "SALARY_HIKE" && spec.percent ? { type: "SALARY_HIKE", params: { percentIncrease: spec.percent } }
      : spec.type === "SALARY_DROP" && spec.percent ? { type: "SALARY_DROP", params: { percentDecrease: spec.percent } }
      : spec.type === "RETIREMENT_AGE_SHIFT" && spec.age ? { type: "RETIREMENT_AGE_SHIFT", params: { newRetirementAge: spec.age } }
      : null;

    const studio = await runStep("scenario studio", () => this.studio.build(c.userId, c.question), SCENARIO_TIMEOUT_MS);
    let usedSimulatorFallback = false;
    if (studio.ok && studio.data.understood && studio.data.variants.length > 0) {
      const base = studio.data.variants.find((v) => v.label === "base") ?? studio.data.variants[0];
      const narrative = studio.data.verificationPassed ? studio.data.explanation : base.run.result.narrative;
      const r = this.applyRun(c, studio.data.scenarioType ?? "SCENARIO", `What if: ${cleanText(c.question, 120)}`, base.params as Record<string, number | string>, base.run, "scenario_studio", narrative);
      b.engine("scenario", "used", "Scenario Studio");
      const best = studio.data.ranked[0];
      if (best) b.finding(`Scenario Studio ranks the "${best.label}" variant highest.`, "info");
      if (studio.data.monteCarloSummary) b.assume("A fast Monte Carlo preview was also run by Scenario Studio; only the deterministic base case is shown here.");
      return this.finishWhatIf(c, r);
    }
    if (studio.ok && !studio.data.understood && !direct) {
      b.engine("scenario", "used", "Scenario Studio could not interpret the question");
      b.gap("SCENARIO_NOT_UNDERSTOOD", "The what-if could not be matched to a supported scenario.", "No projection was made.");
      this.scenarioStudioAction(c);
      return { answer: cleanText(studio.data.explanation, 600), type: "clarification", sufficiency: "insufficient", explainable: false };
    }

    if (direct) {
      const sim = await runStep("simulator", () => this.simulator.run(c.userId, direct.type, direct.params), SCENARIO_TIMEOUT_MS);
      if (sim.ok) {
        usedSimulatorFallback = true;
        const r = this.applyRun(c, direct.type, `What if: ${cleanText(c.question, 120)}`, direct.params, sim.data, "simulator", sim.data.result.narrative);
        b.engine("scenario", "used", `Simulator (Scenario Studio was unavailable: ${studio.ok ? "no result" : studio.reason})`);
        b.assume("Scenario Studio was unavailable, so the deterministic Simulator ran the stated change directly; variants and sensitivity are not shown.");
        b.partial = true;
        void s;
        return this.finishWhatIf(c, r, usedSimulatorFallback);
      }
    }
    b.engine("scenario", "unavailable", studio.ok ? "no result" : studio.reason);
    b.partial = true;
    b.gap("SCENARIO_UNAVAILABLE", "The scenario engines could not produce a projection.", "No result is shown rather than an estimate.");
    this.scenarioStudioAction(c);
    return { answer: "I couldn't run that what-if just now. I haven't estimated it by hand; you can open it in Scenario Studio or try again shortly.", type: "what_if", sufficiency: "insufficient", explainable: false };
  }

  private finishWhatIf(c: Ctx, r: { cf: number; nwDelta: number; nwProj: number }, fallback = false): HandlerResult {
    const { b } = c;
    b.money("cashflow-delta", "Monthly cash-flow change", round2(toDecimal(r.cf)), "estimate");
    b.money("networth-delta", "5-year net worth change", round2(toDecimal(r.nwDelta)), "estimate");
    b.followUp("Am I financially healthy?");
    this.scenarioStudioAction(c);
    const dirText = r.nwDelta > 0 ? "improves" : r.nwDelta < 0 ? "reduces" : "does not change";
    b.finding(`Five-year net worth ${dirText}${r.nwDelta === 0 ? "" : ` by ${inr(Math.abs(r.nwDelta))}`}.`, r.nwDelta > 0 ? "good" : r.nwDelta < 0 ? "warn" : "info");
    return {
      answer: `Projected effect: monthly cash flow ${signedInr(r.cf)}, and net worth in 5 years ${signedInr(r.nwDelta)} (to ${inr(r.nwProj)}). This is a projection based on stated assumptions${fallback ? " from the Simulator" : ""}.`,
      type: "what_if",
      sufficiency: fallback ? "partial" : "sufficient",
      explainable: true,
    };
  }

  private pickLoan(loans: LoanRow[], hint?: string): { loan: LoanRow; how: string } | null {
    if (loans.length === 0) return null;
    if (hint) {
      const h = hint.toLowerCase();
      const hit = loans.filter((l) => l.lender.toLowerCase().includes(h) || String(l.type).toLowerCase().includes(h));
      if (hit.length === 1) return { loan: hit[0], how: `matched to your ${hit[0].lender} loan` };
    }
    if (loans.length === 1) return { loan: loans[0], how: "your only loan" };
    const top = [...loans].sort((a, z) => num(z.interestRateAnnual) - num(a.interestRateAnnual) || a.id.localeCompare(z.id))[0];
    return { loan: top, how: `your highest-rate loan (${top.lender}, ${num(top.interestRateAnnual)}%)` };
  }

  private async prepayScenario(c: Ctx, amount: number | undefined, hint?: string): Promise<HandlerResult> {
    const { b, s } = c;
    if (!amount) return this.clarify(c, "How much would you like to prepay (for example ₹2 lakh)?");
    const debt = await s.debt();
    if (!debt.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Loans could not be read.", "Prepayment impact cannot be calculated.");
      return { answer: "I couldn't read your loans just now, so I can't calculate a prepayment impact.", type: "what_if", sufficiency: "insufficient" };
    }
    const picked = this.pickLoan(debt.data.loans, hint);
    if (!picked) {
      b.gap("NO_LOANS", "You have no loans recorded.", "There is nothing to prepay.");
      return { answer: "You don't have any loans recorded, so there is nothing to prepay. Add a loan first if you have one.", type: "what_if", sufficiency: "insufficient" };
    }
    const { loan, how } = picked;
    const outstanding = num(loan.outstandingPrincipal);
    const lump = Math.min(amount, outstanding);
    b.assume(`Loan used: ${how}. ${debt.data.loans.length > 1 && !hint ? "Name a lender to choose a different one." : ""}`.trim());
    const [impact, sim] = await Promise.all([s.prepayment(loan.id, lump), runStep("simulator", () => this.simulator.run(c.userId, "LOAN_PREPAYMENT", { loanId: loan.id, lumpSum: lump }), SCENARIO_TIMEOUT_MS)]);
    if (!impact.ok) {
      b.gap("SOURCE_UNAVAILABLE", "The loan amortisation could not be computed.", "Prepayment impact cannot be shown.");
      return { answer: "I couldn't compute the prepayment impact just now, so I won't estimate it.", type: "what_if", sufficiency: "insufficient" };
    }
    b.money("prepay-amount", "Prepayment", lump);
    b.money("loan-outstanding", `${loan.lender} outstanding`, outstanding);
    b.item("loan-rate", "Interest rate", num(loan.interestRateAnnual), pct(num(loan.interestRateAnnual)), "%", "verified");
    b.calculations.push({ id: "prepay-interest-saved", label: "Interest saved", formula: "total interest on the current schedule − total interest after the lump sum (same EMI)", inputs: [{ label: "Lump sum", value: inr(lump) }, { label: "Rate", value: pct(num(loan.interestRateAnnual)) }], result: impact.data.interestSaved, display: inr(impact.data.interestSaved), unit: "INR", assumptions: ["The EMI stays the same, so the loan ends sooner."], quality: "verified" });
    b.calculations.push({ id: "prepay-months-saved", label: "Months saved", formula: "remaining months now − remaining months after the lump sum", inputs: [{ label: "Now", value: `${impact.data.originalTenureMonths} months` }, { label: "After", value: `${impact.data.newTenureMonths} months` }], result: impact.data.monthsSaved, display: `${impact.data.monthsSaved} months`, unit: "months", assumptions: [], quality: "verified" });
    if (sim.ok) {
      const r = this.applyRun(c, "LOAN_PREPAYMENT", `Prepay ${inr(lump)} on ${loan.lender}`, { loanId: loan.id, lumpSum: lump }, sim.data, "simulator", sim.data.result.narrative);
      b.engine("scenario", "used", "Simulator");
      void r;
    } else {
      b.engine("scenario", "unavailable", sim.reason);
      b.assume("The 5-year net-worth projection was unavailable; the interest and tenure figures above are still exact.");
      b.partial = true;
    }
    if (amount > outstanding) b.assume(`The amount is more than the outstanding balance, so ${inr(outstanding)} is used.`);
    b.risk("Prepaying uses cash that could otherwise protect you in an emergency; check your emergency fund first.");
    this.scenarioStudioAction(c);
    b.open("Open Loans", "/money/loans", "See the loan and record a prepayment.");
    b.followUp("Should I prepay my loan or invest in a SIP?");
    return { answer: `Prepaying ${inr(lump)} on your ${loan.lender} loan would save about ${inr(impact.data.interestSaved)} in interest and cut ${impact.data.monthsSaved} months off the loan (${impact.data.originalTenureMonths} → ${impact.data.newTenureMonths}).`, type: "what_if", sufficiency: "sufficient", explainable: true };
  }

  // --- house ------------------------------------------------------------------------------------------------

  private async house(c: Ctx, price: number, spec: CoachUnderstanding["house"]): Promise<HandlerResult> {
    const { b, s } = c;
    const down = spec?.downPaymentPercent ?? ILLUSTRATIVE_HOUSE_ASSUMPTIONS.downPaymentPercent;
    const rate = spec?.annualRatePercent ?? ILLUSTRATIVE_HOUSE_ASSUMPTIONS.annualRatePercent;
    const tenure = spec?.tenureYears ?? ILLUSTRATIVE_HOUSE_ASSUMPTIONS.tenureYears;
    const basis = await this.lastCompleteBasis(c);
    const [debt, position, retirement, emergency] = await Promise.all([s.debt(), s.position(), s.retirement(), this.emergencyAssessment(c)]);

    if (spec?.downPaymentPercent === undefined) b.assume(`Down payment of ${down}% is an illustrative assumption: you did not state one.`);
    if (spec?.annualRatePercent === undefined) b.assume(`Loan rate of ${rate}% a year is an illustrative assumption: you did not state one.`);
    if (spec?.tenureYears === undefined) b.assume(`Loan tenure of ${tenure} years is an illustrative assumption: you did not state one.`);
    b.assume("Stamp duty, registration, brokerage and other closing costs are not included.");
    b.assume("Available cash comes from your recorded income and expenses (no opening bank balance is stored), so it may differ from your real balance.");

    const existingEmi = debt.ok ? toDecimal(debt.data.totalMonthlyEmi) : null;
    const cash = position.ok ? toDecimal(position.data.cash.available) : null;
    const a = assessHousePurchase({
      price,
      downPaymentPercent: down,
      annualRatePercent: rate,
      tenureYears: tenure,
      monthlyIncome: basis.income,
      monthlySpending: basis.spending,
      existingMonthlyEmi: existingEmi ?? 0,
      availableCash: cash,
      emergencyTargetAmount: emergency?.targetAmount ?? null,
    });
    if (!debt.ok) b.gap("SOURCE_UNAVAILABLE", "Existing loans could not be read.", "Existing EMIs are treated as unknown; the EMI load below may be understated.");
    if (basis.income === null) b.gap("NO_INCOME_RECORDED", `No income is recorded for ${basis.month}.`, "Affordability cannot be judged without income.");

    b.money("price", "Price", price);
    b.money("down-payment", `Down payment (${down}%)`, round2(a.downPayment), "estimate");
    b.money("loan-amount", "Loan amount", round2(a.loanAmount), "estimate");
    b.money("new-emi", "New EMI", round2(a.newEmi), "estimate");
    b.money("cash", "Available cash", cash ? round2(cash) : null);
    b.money("cash-after", "Cash after down payment", a.cashAfterDownPayment ? round2(a.cashAfterDownPayment) : null, "estimate");
    b.money("surplus-after", "Monthly surplus after all EMIs", a.monthlySurplusAfter ? round2(a.monthlySurplusAfter) : null, "estimate");
    if (a.emiToIncomeAfter) b.item("emi-ratio", "Total EMI to income", roundPct1(a.emiToIncomeAfter), pct(roundPct1(a.emiToIncomeAfter)), "%", "estimate");
    b.calculations.push({ id: "house-emi", label: "New EMI", formula: "standard EMI formula: P×r×(1+r)^n ÷ ((1+r)^n − 1), r = annual rate ÷ 12", inputs: [{ label: "Loan", value: inr(round2(a.loanAmount)) }, { label: "Rate", value: pct(rate) }, { label: "Tenure", value: `${tenure} years` }], result: round2(a.newEmi), display: inr(round2(a.newEmi)), unit: "INR", assumptions: [], quality: "estimate" });

    // Retirement trade-off: surplus left after the house vs the SIP the retirement plan needs.
    const reqSip = retirement.ok ? num(retirement.data.requiredMonthlySip) : null;
    if (reqSip !== null && reqSip > 0 && a.monthlySurplusAfter) {
      const left = round2(a.monthlySurplusAfter);
      b.finding(left >= reqSip ? `Surplus after the house (${inr(left)}) still covers the ${inr(reqSip)} monthly SIP your retirement plan needs.` : `Surplus after the house (${inr(left)}) would not cover the ${inr(reqSip)} monthly SIP your retirement plan needs.`, left >= reqSip ? "good" : "warn");
    } else if (!retirement.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Retirement plan could not be read.", "The effect on retirement saving is not assessed.");
    }

    // Time to build the down payment when cash falls short.
    if (cash && a.cashAfterDownPayment && a.cashAfterDownPayment.lt(0) && basis.income !== null && basis.spending !== null) {
      const monthlyFree = toDecimal(basis.income).minus(basis.spending).minus(existingEmi ?? 0);
      if (monthlyFree.gt(0)) {
        const months = Math.ceil(a.cashAfterDownPayment.abs().div(monthlyFree).toNumber());
        b.predictions.push({ id: "months-to-down-payment", label: "Months to build the missing down payment", display: `${months} months`, value: months, unit: "months", horizon: "at your last complete month's surplus, no investment growth", assumptions: ["Assumes surplus stays the same and is fully saved."] });
      }
    }
    if (spec?.horizonMonths) b.assume(`You mentioned a horizon of about ${spec.horizonMonths} months; cash today is used, not a projection.`);

    const sim = await runStep("simulator", () => this.simulator.run(c.userId, "HOUSE_PURCHASE", { propertyValue: price, downPaymentPercent: down, loanInterestRateAnnual: rate, loanTenureMonths: tenure * 12 }), SCENARIO_TIMEOUT_MS);
    if (sim.ok) {
      this.applyRun(c, "HOUSE_PURCHASE", `Buy a ${inr(price)} house`, { propertyValue: price, downPaymentPercent: down, loanInterestRateAnnual: rate, loanTenureMonths: tenure * 12 }, sim.data, "simulator", sim.data.result.narrative);
      b.engine("scenario", "used", "Simulator");
    } else {
      b.engine("scenario", "unavailable", sim.reason);
      b.partial = true;
      b.assume("The 5-year net-worth projection was unavailable; the affordability figures above are unaffected.");
    }
    for (const reason of a.reasons) b.risk(`Affordability: ${reason}.`);
    b.risk("A property is illiquid and its price can fall; the Simulator projection is not a guarantee.");
    this.scenarioStudioAction(c);
    b.open("Open Loans", "/money/loans", "Review your existing loans.");
    b.followUp("How is my emergency fund?");
    b.followUp("Am I on track for retirement?");

    const verdictText = { comfortable: "looks comfortable", stretch: "would be a stretch", not_affordable: "does not look affordable", unknown: "can't be judged yet" }[a.verdict];
    const reasonText = a.reasons.length ? ` (${a.reasons.join("; ")})` : "";
    const answer =
      a.verdict === "unknown"
        ? `I can't judge whether a ${inr(price)} house is affordable yet: income or cash isn't recorded. With the assumed terms the EMI would be ${inr(round2(a.newEmi))} a month.`
        : `On these terms, a ${inr(price)} house ${verdictText}${reasonText}. The EMI would be ${inr(round2(a.newEmi))} a month (${down}% down, ${rate}% for ${tenure} years), taking total EMIs to ${a.emiToIncomeAfter ? `${roundPct1(a.emiToIncomeAfter)}% of income` : "an unknown share of income"}.`;
    return { answer, type: "planning", sufficiency: a.verdict === "unknown" ? "insufficient" : b.partial ? "partial" : "sufficient", explainable: true };
  }

  // --- prepay vs SIP ----------------------------------------------------------------------------------------------

  private async prepayVsSip(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const [debt, profile, emergency, prefs, basis] = await Promise.all([s.debt(), s.retirementProfile(), this.emergencyAssessment(c), s.preferencesOrNone(), this.lastCompleteBasis(c)]);
    if (!debt.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Loans could not be read.", "The comparison cannot be made.");
      return { answer: "I couldn't read your loans just now, so I can't compare prepaying with investing.", type: "planning", sufficiency: "insufficient" };
    }
    const picked = this.pickLoan(debt.data.loans);
    if (!picked) {
      b.gap("NO_LOANS", "You have no loans recorded.", "There is nothing to prepay, so the question reduces to whether to invest.");
      return { answer: "You have no loans recorded, so there's nothing to prepay. If you have a surplus, investing it (after an emergency fund) is the open question.", type: "planning", sufficiency: "insufficient" };
    }
    const { loan, how } = picked;
    const stated = primaryAmount(c.question, 1000);
    const amount = stated ?? ILLUSTRATIVE_PREPAY_UNIT;
    if (!stated) b.assume(`No amount was stated, so ${inr(ILLUSTRATIVE_PREPAY_UNIT)} is used as an illustrative unit.`);
    const lump = Math.min(amount, num(loan.outstandingPrincipal));
    const loanRate = num(loan.interestRateAnnual);
    const returnPct = profile.ok ? num(profile.data.expectedReturnPreRetirementPercent) : ASSUMED_RETURN_FALLBACK_PERCENT;
    if (!profile.ok) b.assume(`Your expected-return assumption could not be read; ${ASSUMED_RETURN_FALLBACK_PERCENT}% is assumed.`);
    else b.assume(`Expected investment return of ${returnPct}% a year comes from your retirement profile.`);
    b.assume(`Loan used: ${how}.`);

    const impact = await s.prepayment(loan.id, lump);
    if (!impact.ok) {
      b.gap("SOURCE_UNAVAILABLE", "The loan amortisation could not be computed.", "The comparison cannot be made.");
      return { answer: "I couldn't compute the loan's prepayment impact just now, so I won't guess at the comparison.", type: "planning", sufficiency: "insufficient" };
    }
    const horizonYears = Math.max(1, Math.min(30, Math.ceil(impact.data.originalTenureMonths / 12)));
    const growth = projectSip({ currentValue: lump, monthlySip: 0, annualReturnPercent: returnPct, years: horizonYears });
    const gain = round2(growth.projectedGain);
    const saved = impact.data.interestSaved;

    b.money("amount", "Amount compared", lump, stated ? "verified" : "estimate");
    b.item("loan-rate", `${loan.lender} rate`, loanRate, pct(loanRate), "%", "verified");
    b.item("return", "Expected return", returnPct, pct(returnPct), "%", profile.ok ? "verified" : "estimate");
    b.calculations.push({ id: "prepay-saving", label: "Interest saved by prepaying", formula: "interest on current schedule − interest after the lump sum (same EMI)", inputs: [{ label: "Lump sum", value: inr(lump) }, { label: "Loan rate", value: pct(loanRate) }], result: saved, display: inr(saved), unit: "INR", assumptions: ["Pre-tax; ignores any tax benefit on loan interest."], quality: "verified" });
    b.calculations.push({ id: "invest-gain", label: `Gain from investing for ${horizonYears} years`, formula: "lump sum × ((1 + monthly return)^months − 1)", inputs: [{ label: "Lump sum", value: inr(lump) }, { label: "Return", value: pct(returnPct) }, { label: "Horizon", value: `${horizonYears} years (remaining loan term)` }], result: gain, display: inr(gain), unit: "INR", assumptions: ["Return is an assumption, not a guarantee; pre-tax."], quality: "estimate" });
    b.charts.push({ id: "prepay-vs-invest", kind: "bar", title: "Prepay vs invest (pre-tax)", unit: "INR", xKey: "name", series: [{ key: "amount", label: "Benefit" }], data: [{ name: "Interest saved", amount: saved }, { name: "Investment gain", amount: gain }], note: "Investment gain is an assumption-based projection.", source: "Loan amortisation and retirement-profile return" });

    let choice: "prepay" | "sip" | "neither" | "unclear";
    let reason: string;
    const lowCash = emergency ? emergency.verdict === "low" || emergency.verdict === "partial" : false;
    const negativeCash = basis.income !== null && basis.spending !== null && basis.income - basis.spending < 0;
    if (lowCash || negativeCash) {
      choice = "neither";
      reason = negativeCash ? "your last complete month had spending above income" : "your emergency fund is below target";
    } else if (prefs.avoidDebtPrepayment && prefs.avoidInvestmentIncrease) {
      choice = "unclear";
      reason = "your saved constraints rule out both";
    } else if (prefs.avoidDebtPrepayment) {
      choice = "sip";
      reason = "you've said you don't want to prepay debt";
    } else if (prefs.avoidInvestmentIncrease) {
      choice = "prepay";
      reason = "you've said you don't want to increase investing";
    } else if (loanRate >= returnPct) {
      choice = "prepay";
      reason = `the loan rate (${loanRate}%) is at or above the assumed return (${returnPct}%), and prepaying is a guaranteed saving`;
    } else if (returnPct - loanRate >= 2) {
      choice = "sip";
      reason = `the assumed return (${returnPct}%) is at least 2 points above the loan rate (${loanRate}%), though returns are not guaranteed`;
    } else {
      choice = "prepay";
      reason = `the assumed return (${returnPct}%) is not clearly above the loan rate (${loanRate}%), so the certain saving wins`;
    }
    b.assume("Rule: prepay if the loan rate is at or above the assumed return; invest if the return exceeds the loan rate by 2 points or more; otherwise prepay. Safety first: neither while the emergency fund is below target or cash flow is negative.");
    if (loanRate >= HIGH_INTEREST_RATE_PERCENT) b.finding(`${loan.lender} charges ${loanRate}%, which is high.`, "warn");
    b.finding(`Prepaying saves ${inr(saved)} in interest; investing the same amount might gain ${inr(gain)} over ${horizonYears} years (assumption-based).`, "info");
    b.risk("Investment returns can be negative; interest saved on a loan is certain.");
    b.risk("Tax effects (interest deductions, capital-gains tax) are not included.");
    if (choice === "neither") b.step("Build your emergency fund first", "Bring it to target before prepaying or investing extra.", { href: "/money/emergency-fund" });
    else if (choice === "prepay") b.step(`Prepay ${inr(lump)} on ${loan.lender}`, "Confirm the lender's prepayment terms and charges first.", { href: "/money/loans" });
    else if (choice === "sip") b.step(`Invest ${inr(lump)} (or start a SIP)`, "Choose an allocation that matches your risk profile.", { href: "/money/investments" });
    b.open("Open Loans", "/money/loans", "See the loan and its prepayment options.");
    this.scenarioStudioAction(c);
    b.followUp(`What if I prepay ${inr(lump)} on my loan?`);
    const text = { prepay: "prepay the loan", sip: "invest it", neither: "do neither for now", unclear: "choose between them yourself (your constraints rule out both)" }[choice];
    return { answer: `On these numbers, ${choice === "neither" ? "I'd" : "I'd lean to"} ${text}: ${reason}. Prepaying ${inr(lump)} saves ${inr(saved)} in interest; investing it is projected to gain ${inr(gain)} over ${horizonYears} years, but that is not guaranteed.`, type: "planning", sufficiency: b.partial ? "partial" : "sufficient", explainable: true };
  }

  // --- goals ----------------------------------------------------------------------------------------------------

  private async goalAcceleration(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const [goals, emergency, position, basis, debt] = await Promise.all([s.goals(), this.emergencyAssessment(c), s.position(), this.lastCompleteBasis(c), s.debt()]);
    if (!goals.ok) {
      b.gap("SOURCE_UNAVAILABLE", "Goals could not be read.", "No goal advice can be given.");
      return { answer: "I couldn't read your goals just now, so I can't suggest how to reach them sooner.", type: "planning", sufficiency: "insufficient" };
    }
    const assessed = goals.data.assessed;
    const active = assessed.filter((g) => g.state === "ACTIVE");
    for (const g of assessed.filter((x) => x.state === "FUNDED")) b.finding(`${g.name} is already fully funded; nothing more is needed.`, "good");
    for (const g of assessed.filter((x) => x.state === "OVERDUE")) b.finding(`${g.name} is past its target date with ${inr(g.shortfall)} still to go; move the date or add a lump sum.`, "warn");
    if (assessed.some((g) => g.staleRequirement)) b.gap("STALE_GOAL_REQUIREMENT", "A funded goal still shows a monthly requirement.", "It is ignored in this analysis.");
    if (active.length === 0) {
      b.followUp("Am I financially healthy?");
      return { answer: assessed.length === 0 ? "You have no goals recorded yet, so there's nothing to speed up. Add a goal first." : "None of your goals needs more saving right now: they're either fully funded or past their date.", type: "planning", sufficiency: assessed.length === 0 ? "insufficient" : "sufficient" };
    }
    const target = [...active].sort((x, y) => (x.paceRatio ?? 99) - (y.paceRatio ?? 99) || (x.monthsLeft ?? 0) - (y.monthsLeft ?? 0) || x.id.localeCompare(y.id))[0];
    const raw = goals.data.raw.find((g) => g.id === target.id)!;
    const returnPct = num(raw.assumedAnnualReturnPercent) || 0;
    const monthsLeft = target.monthsLeft ?? 0;
    const emi = debt.ok ? toDecimal(debt.data.totalMonthlyEmi) : null;
    const surplus = basis.income !== null && basis.spending !== null && emi ? round2(toDecimal(basis.income).minus(basis.spending).minus(emi)) : null;
    const required = target.requiredMonthly ?? 0;
    const lowCash = emergency ? emergency.verdict !== "adequate" : true;
    const excess = position.ok && emergency && emergency.verdict === "adequate" && emergency.targetAmount ? Math.max(0, round2(toDecimal(position.data.cash.available).minus(emergency.targetAmount))) : 0;
    const lump = Math.min(excess, target.shortfall);

    b.item("goal", "Focus goal", null, target.name, "text", "verified");
    b.money("shortfall", "Still to save", target.shortfall);
    b.money("current-monthly", "Current monthly contribution", target.monthlyContribution);
    b.money("required-monthly", "Needed monthly to finish on time", required);
    b.item("months-left", "Months left", monthsLeft, `${monthsLeft} months`, "months", "verified");
    b.money("surplus", "Monthly surplus after EMIs", surplus);
    b.calculations.push({ id: "goal-required", label: "Required monthly contribution", formula: "from the Goals module: (target − projected current value) spread over the months left", inputs: [{ label: "Shortfall", value: inr(target.shortfall) }, { label: "Months left", value: String(monthsLeft) }], result: required, display: inr(required), unit: "INR", assumptions: [], quality: "verified" });

    const plusMonths = monthsToReach({ target: target.target, currentValue: target.saved, monthly: target.monthlyContribution + ILLUSTRATIVE_EXTRA_MONTHLY, annualReturnPercent: returnPct });
    const currentMonths = monthsToReach({ target: target.target, currentValue: target.saved, monthly: target.monthlyContribution, annualReturnPercent: returnPct });
    const fits = (n: number) => (surplus === null ? "cannot be checked (income, spending or EMIs not fully recorded)" : n <= surplus ? "fits your surplus" : "exceeds your surplus");
    b.assume(`Illustrative lever: +${inr(ILLUSTRATIVE_EXTRA_MONTHLY)} a month; growth uses the goal's own assumed return of ${returnPct}%.`);
    if (currentMonths !== null) b.predictions.push({ id: "months-current", label: "Months to finish at the current contribution", display: `${currentMonths} months`, value: currentMonths, unit: "months", horizon: "from today", assumptions: [`Growth at the goal's assumed return of ${returnPct}%.`] });
    if (plusMonths !== null) b.predictions.push({ id: "months-plus", label: `Months to finish with +${inr(ILLUSTRATIVE_EXTRA_MONTHLY)}/month`, display: `${plusMonths} months`, value: plusMonths, unit: "months", horizon: "from today", assumptions: [`+${inr(ILLUSTRATIVE_EXTRA_MONTHLY)} a month is illustrative.`] });
    if (lump > 0) b.calculations.push({ id: "goal-lump", label: "Lump sum from cash above emergency target", formula: "available cash \u2212 emergency target, capped at the shortfall", inputs: [{ label: "Excess cash", value: inr(excess) }, { label: "Shortfall", value: inr(target.shortfall) }], result: lump, display: inr(lump), unit: "INR", assumptions: ["Cash is derived from recorded income and expenses (no opening balance is stored)."], quality: "estimate" });
    b.finding(`${fits(required)}: ${inr(required)} a month to hit the date.`, "info");

    let pick: string;
    if (lowCash) {
      pick = "Build your emergency fund before pushing a goal: it isn't at target (or can't be assessed).";
      b.step("Fix emergency cover first", "Reach your emergency target, then redirect that amount to the goal.", { href: "/money/emergency-fund" });
    } else if (lump >= target.shortfall && lump > 0) {
      pick = `Use ${inr(lump)} of cash above your emergency target: it covers the whole shortfall.`;
      b.step(`Move ${inr(lump)} into ${target.name}`, "Cash above your emergency target covers the shortfall.", { href: "/goals" });
    } else if (surplus !== null && required <= surplus) {
      pick = `Raise the monthly contribution to ${inr(required)}: it fits your surplus of ${inr(surplus)}.`;
      b.step(`Raise the contribution to ${inr(required)} a month`, `This hits the target date and ${fits(required)}.`, { href: "/goals" });
    } else if (surplus !== null && surplus > 0) {
      pick = `Your surplus (${inr(surplus)}) can't reach ${inr(required)}; add what you can${lump > 0 ? `, use the ${inr(lump)} of spare cash` : ""}, or extend the date.`;
      b.step("Add what your surplus allows", `Up to ${inr(surplus)} a month, then re-check the date.`, { href: "/goals" });
    } else {
      pick = "There's no recorded monthly surplus to add; the realistic lever is moving the target date.";
      b.step("Move the target date", currentMonths === null ? "At the current pace the goal isn't reached." : `At the current pace it finishes in about ${currentMonths} months.`, { href: "/goals" });
    }
    b.finding(pick, lowCash ? "warn" : "info");
    b.risk("Goal timelines depend on steady contributions and the assumed return.");
    b.open("Open Goals", "/goals", "Change the contribution or target date.");
    b.followUp("Am I financially healthy?");
    return { answer: `For "${target.name}" (${inr(target.shortfall)} to go, ${monthsLeft} months left): ${pick}`, type: "planning", sufficiency: surplus === null ? "partial" : "sufficient", explainable: true };
  }

  private async savingsPlan(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const plan = c.u.plan!;
    if (!plan.targetAmount && !plan.months) return this.clarify(c, "How much would you like to save, and by when (for example ₹5 lakh in 2 years)?");
    if (!plan.targetAmount) return this.clarify(c, "How much would you like to save in total?");
    if (!plan.months) return this.clarify(c, `By when would you like to reach ${inr(plan.targetAmount)} (for example in 24 months)?`);
    const target = plan.targetAmount;
    const months = plan.months;
    const basis = await this.lastCompleteBasis(c);
    const debt = await s.debt();
    const emi = debt.ok ? toDecimal(debt.data.totalMonthlyEmi) : null;
    const surplus = basis.income !== null && basis.spending !== null && emi ? round2(toDecimal(basis.income).minus(basis.spending).minus(emi)) : null;
    const flat = requiredMonthlyContribution({ target, currentValue: 0, annualReturnPercent: 0, months })!;
    const grown = requiredMonthlyContribution({ target, currentValue: 0, annualReturnPercent: ILLUSTRATIVE_SAVINGS_RETURN_PERCENT, months })!;
    const flatN = round2(flat);
    const grownN = round2(grown);
    b.money("target", "Target", target);
    b.item("months", "Time", months, `${months} months`, "months", "verified");
    b.money("monthly-flat", "Needed monthly (no growth)", flatN);
    b.money("monthly-grown", `Needed monthly (${ILLUSTRATIVE_SAVINGS_RETURN_PERCENT}% growth assumed)`, grownN, "estimate");
    b.money("surplus", "Monthly surplus after EMIs", surplus);
    b.calculations.push({ id: "required-flat", label: "Required monthly saving (no growth)", formula: "target ÷ months", inputs: [{ label: "Target", value: inr(target) }, { label: "Months", value: String(months) }], result: flatN, display: inr(flatN), unit: "INR", assumptions: [], quality: "verified" });
    b.calculations.push({ id: "required-grown", label: `Required monthly saving (${ILLUSTRATIVE_SAVINGS_RETURN_PERCENT}% a year)`, formula: "target ÷ ((1+r)^n − 1)/r × (1+r), r = annual rate ÷ 12, contributions at the start of each month", inputs: [{ label: "Target", value: inr(target) }, { label: "Months", value: String(months) }], result: grownN, display: inr(grownN), unit: "INR", assumptions: [`${ILLUSTRATIVE_SAVINGS_RETURN_PERCENT}% is an illustrative return, not a promise.`], quality: "estimate" });
    b.assume(`${ILLUSTRATIVE_SAVINGS_RETURN_PERCENT}% a year is an illustrative return; the no-growth figure needs no assumption.`);
    b.assume("Contributions are assumed at the start of each month, starting from zero saved.");
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const m = Math.max(1, Math.round(months * frac));
      b.step(`${Math.round(frac * 100)}% milestone`, `By month ${m}, aim for about ${inr(round2(toDecimal(flatN).times(m)))} saved (no growth).`, { timeframe: `Month ${m}` });
    }
    if (surplus !== null) {
      const ok = flatN <= surplus;
      b.finding(ok ? `${inr(flatN)} a month fits within your surplus of ${inr(surplus)}.` : `${inr(flatN)} a month is more than your surplus of ${inr(surplus)}.`, ok ? "good" : "warn");
    } else {
      b.gap("SURPLUS_UNKNOWN", "Income, spending or EMIs for the last complete month are not fully recorded.", "Affordability of this plan cannot be checked.");
    }
    b.risk("Growth assumptions are not guaranteed; the no-growth figure is the safe planning number.");

    const targetDate = new Date(c.now);
    targetDate.setUTCMonth(targetDate.getUTCMonth() + months);
    const title = `Save ${inr(target)} in ${months} months`;
    b.actions.push({
      id: "create-plan",
      kind: "CREATE_PLAN",
      label: "Create this plan",
      description: "Saves a tracked savings plan with starter tasks. Nothing is created until you confirm.",
      requiresConfirmation: true,
      payload: { type: "SAVINGS_TARGET", title, objective: cleanText(c.question, 480), targetMetricType: "custom_amount", targetValue: target, targetDate: targetDate.toISOString(), startingValue: 0 },
      preview: { title, changes: [{ label: "Type", value: "Savings target" }, { label: "Target", value: inr(target) }, { label: "By", value: targetDate.toISOString().slice(0, 10) }, { label: "Starting from", value: inr(0) }] },
    });
    b.followUp("What if I increase my SIP by ₹5,000?");
    return { answer: `To save ${inr(target)} in ${months} months you'd need ${inr(flatN)} a month with no growth, or about ${inr(grownN)} a month if it earns an assumed ${ILLUSTRATIVE_SAVINGS_RETURN_PERCENT}% a year.${surplus !== null ? ` Your last complete month's surplus was ${inr(surplus)}.` : ""} I haven't created anything yet; confirm below to save it as a plan.`, type: "planning", sufficiency: surplus === null ? "partial" : "sufficient", explainable: true };
  }

  // --- documents ------------------------------------------------------------------------------------------------------

  private async documents(c: Ctx): Promise<HandlerResult> {
    const { b, s } = c;
    const insurance = c.u.kind === "insurance_document";
    const search = await runStep("ai search", () => this.rag.search(c.userId, c.question, { sourceTypes: ["DOCUMENT"] as never, ...(insurance ? { categories: ["INSURANCE"] } : {}) }));
    let structured = "";
    if (insurance) {
      const ins = await s.insurance();
      if (ins.ok) {
        for (const p of ins.data.policies.slice(0, 8)) b.item(`policy-${p.id}`, `${p.provider} ${String(p.type).toLowerCase()}`, num(p.coverageAmount), `${inr(num(p.coverageAmount))} cover`, "INR", "verified", `Premium ${inr(num(p.premiumAmount))} (${String(p.premiumFrequency).toLowerCase()}), renews ${String(p.renewalDate).slice(0, 10)}`);
        for (const g of ins.data.gaps.filter((x) => !x.hasCoverage || num(x.gap) > 0)) b.finding(cleanText(g.message, 300), "warn");
        structured = ins.data.policies.length ? ` You have ${ins.data.policies.length} polic${ins.data.policies.length === 1 ? "y" : "ies"} recorded.` : " No policies are recorded in Insurance.";
      }
    }
    if (!search.ok) {
      b.engine("ai_search", "unavailable", search.reason);
      b.engine("documents", "unavailable");
      b.partial = true;
      b.gap("SEARCH_UNAVAILABLE", "Document search could not be run.", "Nothing from your documents is shown.");
      return { answer: `I couldn't search your documents just now.${structured} Please try again shortly.`, type: "document", sufficiency: "insufficient", explainable: false };
    }
    b.engine("ai_search", "used");
    const r = search.data;
    if (!r.hasEvidence || r.citedSources.length === 0) {
      b.engine("documents", "used", "No matching passages");
      b.gap("NO_DOCUMENT_EVIDENCE", "No uploaded document contained a passage that answers this.", "Nothing is stated about your documents.");
      b.open("Open AI Search", "/ai-search", "Search your documents and records directly.");
      return { answer: `I couldn't find a passage in your uploaded documents that answers that, so I won't guess.${structured}`, type: "document", sufficiency: "insufficient", explainable: false };
    }
    b.engine("documents", "used", `${r.citedSources.length} passage(s)`);
    const cited: string[] = [];
    for (const src of r.citedSources.slice(0, 8)) {
      cited.push(src.chunkId);
      const snippet = cleanText(src.snippet, 500);
      b.evidence.push({ id: src.chunkId.slice(0, 120), sourceType: cleanText(src.sourceType, 60), sourceName: cleanText(src.title, 200), excerpt: snippet, citation: { chunkId: src.chunkId.slice(0, 200) }, quality: "document_extraction" });
      b.citations.push({ chunkId: src.chunkId.slice(0, 200), sourceType: cleanText(src.sourceType, 60), title: cleanText(src.title, 200), snippet, confidence: src.confidence });
    }
    const grounded = r.groundingScore === null ? false : r.groundingScore >= RAG_MIN_GROUNDING;
    const usable = r.hallucinationRisk !== "high" && grounded && r.answer.trim().length > 0;
    b.assume("Text from documents comes from OCR/extraction and may contain errors; check it against the original.");
    b.risk("Document text is quoted as written and is not treated as instructions or as verified fact.");
    if (!usable) {
      b.partial = true;
      b.gap("LOW_GROUNDING", "The document answer could not be independently verified against its sources.", "Only the source excerpts are shown, not a written answer.");
    }
    b.open("Open AI Search", "/ai-search", "See the full search result with sources.");
    b.followUp("Am I financially healthy?");
    const answer = usable ? `${cleanText(r.answer, 1500)}${structured}` : `I found ${r.citedSources.length} relevant passage(s) in your documents (shown as sources below) but couldn't verify a written summary of them, so please read the excerpts.${structured}`;
    return { answer, type: "document", sufficiency: usable ? "sufficient" : "partial", explainable: false, cited };
  }
}
