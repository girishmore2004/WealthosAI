import { ScenarioType } from "@wealthos/types";
import { deflate, futureValue, round2 } from "../../agent/analysis/financial-math";
import { formatMoney } from "../../agent/analysis/financial-verification";
import { classifyScenarioIntent } from "../parsing/scenario-intent-classifier";
import { PRIMARY_SCENARIO_FIELD, extractPrimaryParams } from "../parsing/scenario-param-utils";

// Compound what-if scenarios: "a 15% salary increase, a 20% expense reduction and a higher SIP".
//
// The single-scenario classifier is deliberately conservative: when it sees more than one scenario in one string it
// refuses, because its keyword windows can pair the wrong words (for example "expense reduction and increased SIP"
// also looks like a SIP decrease). Here the prompt is first split into clauses, each clause is classified ON ITS OWN, and
// each clause's own numbers are read from that clause only. A percentage can therefore never migrate from the salary
// clause to the expense clause, and "increase" in one clause cannot turn a different clause into a decrease.
//
// Nothing in this file calls a model. The single-scenario API is untouched.

/** Scenario types that this module can project together (all of them act on monthly income, expenses or SIP). */
export const COMPOUND_PROJECTABLE: readonly ScenarioType[] = ["SALARY_HIKE", "SALARY_DROP", "EXPENSE_REDUCTION", "SIP_INCREASE", "SIP_DECREASE"];

export type ScenarioStatus = "ready" | "needs_input" | "run_individually";

export interface ScenarioSpec {
  id: string;
  type: ScenarioType;
  label: string;
  clause: string;
  params: Record<string, number>;
  /** Names of required inputs the user did not state. */
  missing: string[];
  status: ScenarioStatus;
  note?: string;
}

export interface Decomposition {
  compound: boolean;
  scenarios: ScenarioSpec[];
  /** Clauses that matched no scenario (e.g. "compare their long-term impact"), kept so nothing is silently discarded. */
  ignoredClauses: string[];
}

const LABELS: Record<ScenarioType, string> = {
  SALARY_HIKE: "Salary increase",
  SALARY_DROP: "Salary decrease",
  EXPENSE_REDUCTION: "Expense reduction",
  SIP_INCREASE: "SIP increase",
  SIP_DECREASE: "SIP decrease",
  HOUSE_PURCHASE: "House purchase",
  LOAN_PREPAYMENT: "Loan prepayment",
  RETIREMENT_AGE_SHIFT: "Retirement age change",
  EMERGENCY_EXPENSE: "Emergency expense",
  GOAL_DELAY: "Goal delay",
  NEW_LOAN: "New loan",
};

const REQUIRED: Partial<Record<ScenarioType, { field: string; ask: string }>> = {
  SALARY_HIKE: { field: "percentIncrease", ask: "the salary increase percentage" },
  SALARY_DROP: { field: "percentDecrease", ask: "the salary decrease percentage" },
  EXPENSE_REDUCTION: { field: "percentDecrease", ask: "the expense reduction percentage" },
  SIP_INCREASE: { field: "additionalMonthlyAmount", ask: "the extra monthly SIP amount in rupees" },
  SIP_DECREASE: { field: "reducedMonthlyAmount", ask: "the monthly SIP reduction in rupees" },
};

// Splits on commas, semicolons, "and", "plus", "as well as", "along with" and "&", but not inside numbers (₹1,50,000).
const CLAUSE_SPLIT = /\s*(?:;|,(?!\d)|\band\b|\bplus\b|\bas well as\b|\balong with\b|&)\s*/i;
const INCREASE_WORDS = /\b(increase[sd]?|increasing|rais(?:e|es|ed|ing)|hike[sd]?|higher|more|extra|additional|boost(?:ed|ing)?|bump(?:ed|ing)?|step(?:ped)? up|top[- ]?up|add(?:ed|ing)?)\b/i;
const DECREASE_WORDS = /\b(decrease[sd]?|decreasing|reduc(?:e|es|ed|ing|tion)|lower(?:ed|ing)?|cut(?:s|ting)?|drop(?:s|ped|ping)?|less|pause[sd]?|stop(?:ped|ping)?|slash(?:ed|ing)?)\b/i;
const SIP_WORDS = /\b(sips?|systematic investment|monthly investments?|monthly contributions?|investment contributions?)\b/i;

function normalise(prompt: string): string {
  return (prompt ?? "").replace(/[‘’]/g, "'").replace(/\s+/g, " ").trim();
}

/** Classifies ONE clause. Falls back to explicit SIP wording because the shared classifier needs an action word next to the subject. */
export function classifyClause(clause: string): ScenarioType | null {
  const intent = classifyScenarioIntent(clause);
  if (intent.status === "clear" && intent.scenarioType) return intent.scenarioType;
  if (SIP_WORDS.test(clause)) {
    const inc = INCREASE_WORDS.test(clause);
    const dec = DECREASE_WORDS.test(clause);
    if (inc && !dec) return "SIP_INCREASE";
    if (dec && !inc) return "SIP_DECREASE";
  }
  return null;
}

export function decomposeScenarioPrompt(prompt: string): Decomposition {
  const text = normalise(prompt);
  const scenarios: ScenarioSpec[] = [];
  const ignored: string[] = [];

  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z₹])/);
  for (const sentence of sentences) {
    for (const rawClause of sentence.split(CLAUSE_SPLIT)) {
      const clause = rawClause.replace(/^(?:run|simulate|show|compare|what[- ]if|what if|please|can you|for|a|an|the)\b\s*/gi, "").trim();
      if (clause.length < 3) continue;
      const type = classifyClause(rawClause);
      if (!type) {
        if (/[a-z]{3,}/i.test(clause)) ignored.push(clause);
        continue;
      }
      scenarios.push(makeSpec(scenarios.length, type, rawClause));
    }
  }

  // A prompt only counts as compound when it names at least two scenarios.
  const compound = scenarios.length >= 2;
  return { compound, scenarios, ignoredClauses: ignored };
}

function makeSpec(index: number, type: ScenarioType, clause: string): ScenarioSpec {
  const label = LABELS[type];
  const base: ScenarioSpec = { id: `s${index + 1}`, type, label, clause, params: {}, missing: [], status: "ready" };
  if (!COMPOUND_PROJECTABLE.includes(type)) {
    return { ...base, status: "run_individually", note: `${label} is modelled by Scenario Studio on its own; ask for it as a separate what-if so its own inputs (amounts, rates, tenure) can be checked.` };
  }
  const required = REQUIRED[type]!;
  const primary = extractPrimaryParams(type, clause);
  const value = primary[PRIMARY_SCENARIO_FIELD[type]];
  if (value === undefined || !(value > 0)) return { ...base, missing: [required.ask], status: "needs_input" };
  if ((type === "SALARY_HIKE" || type === "SALARY_DROP" || type === "EXPENSE_REDUCTION") && value > 100) {
    return { ...base, params: {}, missing: [`${required.ask} (a value above 100% is not valid)`], status: "needs_input" };
  }
  return { ...base, params: { [required.field]: value } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------------------------------------------------

export interface CompoundBaseline {
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlySip: number;
  currentInvestmentValue: number;
}

export interface ProjectionAssumptions {
  annualReturnPercent: number;
  inflationPercent: number;
  /** Share of EXTRA monthly cash (from higher income or lower spending) that is invested. 0 = all of it is kept as cash. */
  investShareOfExtraCashPercent: number;
  horizonsYears: readonly number[];
}

export const DEFAULT_ASSUMPTIONS: ProjectionAssumptions = { annualReturnPercent: 10, inflationPercent: 6, investShareOfExtraCashPercent: 0, horizonsYears: [1, 5, 10, 15, 20] };

export interface ScenarioColumn {
  id: string;
  label: string;
  kind: "baseline" | "single" | "combined" | "illustrative";
  inputsLabel: string;
  monthlyIncome: number;
  monthlyExpenses: number;
  monthlySip: number;
  monthlySurplusAfterSip: number;
  /** Extra monthly cash versus baseline that is invested under the allocation rule. */
  extraInvestedMonthly: number;
  byHorizon: { years: number; investmentValue: number; retainedCash: number; total: number; inflationAdjustedTotal: number; vsBaseline: number }[];
  warnings: string[];
}

export interface CompoundProjection {
  columns: ScenarioColumn[];
  assumptions: ProjectionAssumptions;
  skipped: { spec: ScenarioSpec; reason: string }[];
  questions: string[];
}

function applySpecs(base: CompoundBaseline, specs: readonly ScenarioSpec[]): { income: number; expenses: number; sip: number } {
  let income = base.monthlyIncome;
  let expenses = base.monthlyExpenses;
  let sip = base.monthlySip;
  for (const s of specs) {
    switch (s.type) {
      case "SALARY_HIKE": income = income * (1 + (s.params.percentIncrease ?? 0) / 100); break;
      case "SALARY_DROP": income = income * (1 - (s.params.percentDecrease ?? 0) / 100); break;
      case "EXPENSE_REDUCTION": expenses = expenses * (1 - (s.params.percentDecrease ?? 0) / 100); break;
      case "SIP_INCREASE": sip = sip + (s.params.additionalMonthlyAmount ?? 0); break;
      case "SIP_DECREASE": sip = Math.max(0, sip - (s.params.reducedMonthlyAmount ?? 0)); break;
      default: break;
    }
  }
  return { income: round2(income), expenses: round2(expenses), sip: round2(sip) };
}

function column(id: string, label: string, kind: ScenarioColumn["kind"], inputsLabel: string, base: CompoundBaseline, applied: { income: number; expenses: number; sip: number }, a: ProjectionAssumptions): ScenarioColumn {
  // Extra cash is only the part of the surplus that came from the scenario's income / expense change, not from SIP changes.
  const extraCash = round2(applied.income - base.monthlyIncome + (base.monthlyExpenses - applied.expenses));
  const extraInvested = extraCash > 0 ? round2((extraCash * a.investShareOfExtraCashPercent) / 100) : 0;
  const sipTotal = round2(applied.sip + extraInvested);
  const surplusAfterSip = round2(applied.income - applied.expenses - sipTotal);
  const warnings: string[] = [];
  if (surplusAfterSip < 0) warnings.push(`Monthly cash after spending and SIP is negative (${formatMoney(surplusAfterSip)}); the projection treats that shortfall as being drawn from other savings.`);
  const byHorizon = a.horizonsYears.map((years) => {
    const investmentValue = futureValue(base.currentInvestmentValue, sipTotal, a.annualReturnPercent, years);
    const retainedCash = round2(surplusAfterSip * 12 * years);
    const total = round2(investmentValue + retainedCash);
    return { years, investmentValue, retainedCash, total, inflationAdjustedTotal: deflate(total, a.inflationPercent, years), vsBaseline: 0 };
  });
  return { id, label, kind, inputsLabel, monthlyIncome: applied.income, monthlyExpenses: applied.expenses, monthlySip: sipTotal, monthlySurplusAfterSip: surplusAfterSip, extraInvestedMonthly: extraInvested, byHorizon, warnings };
}

export function projectCompound(base: CompoundBaseline, scenarios: readonly ScenarioSpec[], assumptions: ProjectionAssumptions = DEFAULT_ASSUMPTIONS, illustrativeSipAmounts: readonly number[] = []): CompoundProjection {
  const columns: ScenarioColumn[] = [];
  const skipped: CompoundProjection["skipped"] = [];
  const questions: string[] = [];
  const ready = scenarios.filter((s) => s.status === "ready");

  columns.push(column("baseline", "Baseline", "baseline", "No change", base, applySpecs(base, []), assumptions));
  for (const s of scenarios) {
    if (s.status === "ready") columns.push(column(s.id, s.label, "single", describeParams(s), base, applySpecs(base, [s]), assumptions));
    else if (s.status === "needs_input") {
      skipped.push({ spec: s, reason: `missing ${s.missing.join(", ")}` });
      questions.push(`${s.label}: what is ${s.missing[0]}?`);
    } else skipped.push({ spec: s, reason: s.note ?? "run individually" });
  }
  if (ready.length >= 2) columns.push(column("combined", "Combined", "combined", `All of: ${ready.map((s) => s.label).join(" + ")}`, base, applySpecs(base, ready), assumptions));

  // A scenario with a missing amount is not run with an invented number. Clearly labelled illustrations may be shown beside it.
  for (const s of scenarios.filter((x) => x.status === "needs_input" && (x.type === "SIP_INCREASE" || x.type === "SIP_DECREASE"))) {
    for (const amount of illustrativeSipAmounts) {
      const spec: ScenarioSpec = { ...s, params: { [REQUIRED[s.type]!.field]: amount }, status: "ready", missing: [] };
      columns.push(column(`${s.id}-illustrative-${amount}`, `${s.label} (illustrative ${formatMoney(amount)})`, "illustrative", `ILLUSTRATIVE — not your input: ${formatMoney(amount)}/month`, base, applySpecs(base, [spec]), assumptions));
    }
  }

  const baseline = columns[0];
  for (const c of columns) c.byHorizon = c.byHorizon.map((h, i) => ({ ...h, vsBaseline: round2(h.total - baseline.byHorizon[i].total) }));
  return { columns, assumptions, skipped, questions };
}

function describeParams(s: ScenarioSpec): string {
  const v = Object.values(s.params)[0];
  if (s.type === "SALARY_HIKE" || s.type === "SALARY_DROP" || s.type === "EXPENSE_REDUCTION") return `${v}%`;
  return `${formatMoney(v)}/month`;
}

export function renderCompound(d: Decomposition, p: CompoundProjection, base: CompoundBaseline): string {
  const out: string[] = ["## Compound what-if comparison"];
  out.push("Each scenario is calculated on its own from the figures below, and then all runnable scenarios are combined. Nothing was changed in your account.");
  out.push(`\n**Scenarios understood from your request**`);
  out.push("| # | Scenario | Your wording | Input used | Status |", "|---|---|---|---|---|");
  for (const s of d.scenarios) out.push(`| ${s.id} | ${s.label} | "${s.clause.trim()}" | ${s.status === "ready" ? describeParams(s) : "—"} | ${s.status === "ready" ? "Run" : s.status === "needs_input" ? `Needs ${s.missing.join(", ")}` : "Run separately"} |`);

  out.push(`\n**Baseline from your records:** income ${formatMoney(base.monthlyIncome)}/month, spending ${formatMoney(base.monthlyExpenses)}/month, active SIPs ${formatMoney(base.monthlySip)}/month, current investments ${formatMoney(base.currentInvestmentValue)}.`);

  out.push("\n**Monthly cash flow**");
  out.push(headerRow("Metric", p.columns), alignRow(p.columns));
  out.push(metricRow("Monthly income", p.columns, (c) => formatMoney(c.monthlyIncome)));
  out.push(metricRow("Monthly expenses", p.columns, (c) => formatMoney(c.monthlyExpenses)));
  out.push(metricRow("Monthly SIP", p.columns, (c) => formatMoney(c.monthlySip)));
  out.push(metricRow("Monthly surplus after SIP", p.columns, (c) => formatMoney(c.monthlySurplusAfterSip)));

  out.push("\n**Long-term projection** (investments + retained cash, in future rupees)");
  out.push(headerRow("Horizon", p.columns), alignRow(p.columns));
  for (let i = 0; i < p.assumptions.horizonsYears.length; i++) {
    const y = p.assumptions.horizonsYears[i];
    out.push(metricRow(`${y} year${y === 1 ? "" : "s"}`, p.columns, (c) => formatMoney(c.byHorizon[i].total)));
  }
  out.push("\n**Difference from baseline** (future rupees)");
  out.push(headerRow("Horizon", p.columns), alignRow(p.columns));
  for (let i = 0; i < p.assumptions.horizonsYears.length; i++) {
    const y = p.assumptions.horizonsYears[i];
    out.push(metricRow(`${y} year${y === 1 ? "" : "s"}`, p.columns, (c) => (c.kind === "baseline" ? "—" : `${c.byHorizon[i].vsBaseline >= 0 ? "+" : "−"}${formatMoney(Math.abs(c.byHorizon[i].vsBaseline))}`)));
  }
  out.push("\n**Inflation-adjusted total** (today's rupees)");
  out.push(headerRow("Horizon", p.columns), alignRow(p.columns));
  for (let i = 0; i < p.assumptions.horizonsYears.length; i++) {
    const y = p.assumptions.horizonsYears[i];
    out.push(metricRow(`${y} year${y === 1 ? "" : "s"}`, p.columns, (c) => formatMoney(c.byHorizon[i].inflationAdjustedTotal)));
  }

  const warnings = p.columns.flatMap((c) => c.warnings.map((w) => `${c.label}: ${w}`));
  if (warnings.length > 0) out.push("\n**Cash-flow warnings**\n" + warnings.map((w) => `- ${w}`).join("\n"));
  if (p.skipped.length > 0) out.push("\n**Not included in the comparison**\n" + p.skipped.map((s) => `- ${s.spec.label}: ${s.reason}.`).join("\n"));
  if (p.questions.length > 0) out.push("\n**To include these, I need:**\n" + p.questions.map((q) => `- ${q}`).join("\n"));
  if (d.ignoredClauses.length > 0) out.push(`\nParts of your request that did not describe a scenario: ${d.ignoredClauses.map((c) => `"${c}"`).join("; ")}.`);

  const a = p.assumptions;
  out.push("\n**Assumptions and method**");
  out.push(
    [
      `Investments grow at ${a.annualReturnPercent}% a year, compounded monthly — an illustrative assumption, not a forecast and not guaranteed.`,
      `Inflation is ${a.inflationPercent}% a year; the inflation-adjusted table divides each total by (1 + inflation) raised to the number of years.`,
      `Formula: investments = current value × (1 + r/12)^(12 × years) + monthly SIP × ((1 + r/12)^(12 × years) − 1) ÷ (r/12), with r the annual return.`,
      a.investShareOfExtraCashPercent === 0
        ? "Extra cash from a higher salary or lower spending is NOT invested: it is kept as cash and earns nothing, so each scenario shows only what you explicitly choose to invest. Only a SIP change moves money into investments."
        : `${a.investShareOfExtraCashPercent}% of extra cash from a higher salary or lower spending is invested; the rest is kept as cash.`,
      "Retained cash is the monthly surplus after spending and SIP, accumulated without interest. Existing cash, property and loans are excluded, so totals are not net worth.",
      "Salary changes are applied to the baseline income and the expense reduction to the baseline expenses (their basis is stated above the table). Tax on income changes is not modelled.",
    ]
      .map((l) => `- ${l}`)
      .join("\n"),
  );
  return out.join("\n");
}

const headerRow = (first: string, cols: readonly ScenarioColumn[]): string => `| ${first} | ${cols.map((c) => c.label).join(" | ")} |`;
const alignRow = (cols: readonly ScenarioColumn[]): string => `|---|${cols.map(() => "---:").join("|")}|`;
const metricRow = (name: string, cols: readonly ScenarioColumn[], f: (c: ScenarioColumn) => string): string => `| ${name} | ${cols.map(f).join(" | ")} |`;
