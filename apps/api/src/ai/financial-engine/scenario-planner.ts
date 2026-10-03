import { Prisma } from "@wealthos/db";
import { savingsRate, investmentRate, toMoneyString } from "../../common/financial-facts/financial-formulas";
import { FactValue, ScenarioParams } from "./financial-types";

type Dec = Prisma.Decimal;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

export interface ScenarioBaseline {
  income: string; // actual monthly income
  expenses: string; // actual monthly spending (excludes SIPs / reserve allocations)
  investmentContributions: string; // actual monthly investment contributions
  emergencyAllocations: string; // actual monthly reserve allocations
}

export interface ScenarioOutcome {
  // Always false: scenarios are pure what-if arithmetic over a baseline snapshot. Nothing
  // here (or in its caller) writes to a SIP, income, expense or goal record.
  mutatesData: false;
  basis: "PROJECTED";
  facts: Record<string, FactValue>;
  notes: string[];
  warnings: string[];
}

const money = (d: Dec): FactValue => ({ kind: "MONEY", value: toMoneyString(d) });
const ratio = (d: Dec | null): FactValue | null => (d === null ? null : { kind: "RATIO", value: d.toString() });

/** Monthly cash left after spending, investing and reserve allocations. */
const leftover = (income: Dec, expenses: Dec, contributions: Dec, allocations: Dec): Dec =>
  income.minus(expenses).minus(contributions).minus(allocations);

/**
 * Pure what-if. Applies ONE change to a baseline of ACTUAL monthly figures and reports
 * current vs scenario monthly cash left (Available Cash flow), savings rate and investment
 * rate, plus the 12-month effect. The result is PROJECTED and never persisted.
 *
 * Note a SIP change moves money between buckets: it lowers cash left but not the savings
 * rate (a SIP is not an expense), and the note says so rather than letting the number mislead.
 */
export function calculateScenario(baseline: ScenarioBaseline, change: ScenarioParams): ScenarioOutcome | null {
  if (change.kind === "UNSUPPORTED") return null;
  if (change.amount === null && change.percent === null) return null;

  const income = D(baseline.income);
  const expenses = D(baseline.expenses);
  const contributions = D(baseline.investmentContributions);
  const allocations = D(baseline.emergencyAllocations);
  const sign = change.direction === "INCREASE" ? D(1) : D(-1);

  const target: Dec = change.kind === "SIP_CHANGE" ? contributions : change.kind === "SALARY_CHANGE" ? income : expenses;
  const rawDelta = change.amount !== null ? D(change.amount) : target.times(D(change.percent as string)).div(100);
  let delta = rawDelta.times(sign);

  const warnings: string[] = [];
  const notes: string[] = [];
  // A decrease can't take a quantity below zero.
  if (target.plus(delta).lt(0)) {
    delta = target.negated();
    warnings.push("The reduction is larger than the current amount, so it was capped at the current amount.");
  }

  let sIncome = income;
  let sExpenses = expenses;
  let sContrib = contributions;
  if (change.kind === "SIP_CHANGE") {
    sContrib = contributions.plus(delta);
    notes.push("A SIP is money moved into investments, not spending, so your savings rate does not change; only the cash left each month does.");
  } else if (change.kind === "SALARY_CHANGE") {
    sIncome = income.plus(delta);
  } else {
    sExpenses = expenses.plus(delta);
  }

  const currentLeft = leftover(income, expenses, contributions, allocations);
  const scenarioLeft = leftover(sIncome, sExpenses, sContrib, allocations);
  const diff = scenarioLeft.minus(currentLeft);

  if (scenarioLeft.lt(0)) {
    warnings.push("In this scenario your monthly commitments would exceed your monthly income.");
  }
  if (income.isZero()) {
    warnings.push("No income was recorded this month, so rates cannot be calculated.");
  }

  const facts: Record<string, FactValue> = {
    changeAmount: money(delta.abs()),
    currentMonthlyCashLeft: money(currentLeft),
    scenarioMonthlyCashLeft: money(scenarioLeft),
    monthlyDifference: money(diff.abs()),
    twelveMonthDifference: money(diff.abs().times(12)),
    currentContributions: money(contributions),
    scenarioContributions: money(sContrib),
    currentIncome: money(income),
    scenarioIncome: money(sIncome),
    currentExpenses: money(expenses),
    scenarioExpenses: money(sExpenses),
    emergencyAllocations: money(allocations),
  };
  const cs = ratio(savingsRate(income, expenses));
  const ss = ratio(savingsRate(sIncome, sExpenses));
  const ci = ratio(investmentRate(contributions, income));
  const si = ratio(investmentRate(sContrib, sIncome));
  if (cs) facts.currentSavingsRate = cs;
  if (ss) facts.scenarioSavingsRate = ss;
  if (ci) facts.currentInvestmentRate = ci;
  if (si) facts.scenarioInvestmentRate = si;

  return { mutatesData: false, basis: "PROJECTED", facts, notes, warnings };
}

export { ZERO };
