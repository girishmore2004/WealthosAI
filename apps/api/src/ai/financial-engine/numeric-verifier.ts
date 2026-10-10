import { Prisma } from "@wealthos/db";
import { FactValue, ToolResult, VerificationIssue, VerificationResult } from "./financial-types";

// Final guardrail before any financial answer leaves the engine. It re-checks the TEXT
// against the structured tool facts the answer was built from:
//   1. every rupee amount and percentage in the answer must equal a backend fact
//   2. a percentage must never be a ratio multiplied by 100 twice (0.25 => 25%, never 2500%)
//   3. totals the tools report must reconcile (available + emergency = total, etc.)
//   4. non-ACTUAL bases (projected / forecast / estimate / target) must be labelled as such
//   5. the period the answer speaks about must match the period of the facts
// Pure and synchronous: no I/O, no model.

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

const MONEY_RE = /₹\s?-?\d[\d,]*(?:\.\d+)?/g;
const PERCENT_RE = /-?\d+(?:\.\d+)?\s?%/g;

// formatINR renders whole rupees, so a rendered amount may differ from the exact fact by
// up to half a rupee. Percentages are rendered to at most 2 decimals.
const MONEY_TOLERANCE = 0.51;
const PERCENT_TOLERANCE = 0.051;

const BASIS_LABEL: Record<string, RegExp> = {
  PROJECTED: /scenario|projected|hypothetical|what-if/i,
  FORECAST: /forecast|expected/i,
  ESTIMATED: /estimat/i,
  TARGET: /target/i,
};

function allFacts(tools: ToolResult[]): FactValue[] {
  const out: FactValue[] = [];
  for (const t of tools) {
    out.push(...Object.values(t.facts));
    for (const r of t.rows ?? []) out.push(...Object.values(r.facts));
  }
  return out;
}

function nearlyEqual(a: Prisma.Decimal.Value, b: Prisma.Decimal.Value, tol: number): boolean {
  return D(a).minus(D(b)).abs().lte(tol);
}

export function verifyAnswer(text: string, tools: ToolResult[]): VerificationResult {
  const issues: VerificationIssue[] = [];
  const facts = allFacts(tools);

  // Allowed money: every MONEY fact (compared by absolute value, since an answer may phrase
  // a negative as a shortfall) plus the amounts attached to data-health warnings.
  const allowedMoney: Prisma.Decimal[] = facts.filter((f) => f.kind === "MONEY").map((f) => D(f.value).abs());
  for (const t of tools) for (const w of t.warnings) if (w.amount !== undefined) allowedMoney.push(D(w.amount).abs());
  // Compared by absolute value, like money: "spending was 12.5% lower" is backed by a -0.125 ratio.
  const ratios = facts.filter((f) => f.kind === "RATIO").map((f) => D(f.value).abs());

  // 1. Money
  for (const raw of text.match(MONEY_RE) ?? []) {
    const value = D(raw.replace(/[₹,\s]/g, "")).abs();
    if (!allowedMoney.some((m) => nearlyEqual(m, value, MONEY_TOLERANCE))) {
      issues.push({ code: "UNSUPPORTED_NUMBER", detail: `Amount ${raw.trim()} does not match any backend fact.` });
    }
  }

  // 1b/2. Percentages, with an explicit check for the "multiplied by 100 twice" bug.
  for (const raw of text.match(PERCENT_RE) ?? []) {
    const value = D(raw.replace(/[%\s]/g, "")).abs();
    if (ratios.some((r) => nearlyEqual(r.times(100), value, PERCENT_TOLERANCE))) continue;
    if (ratios.some((r) => nearlyEqual(r.times(10000), value, 0.6))) {
      issues.push({ code: "DOUBLE_PERCENT_SCALE", detail: `${raw.trim()} looks like a ratio multiplied by 100 twice.` });
    } else {
      issues.push({ code: "UNSUPPORTED_NUMBER", detail: `Percentage ${raw.trim()} does not match any backend fact.` });
    }
  }

  // 3. Reconciliation of the totals the tools themselves report.
  for (const t of tools) {
    const f = t.facts;
    const num = (k: string) => (f[k] ? D(f[k].value) : null);
    const av = num("availableCash");
    const em = num("emergencyCash");
    const tc = num("totalCash");
    if (av && em && tc && !nearlyEqual(av.plus(em), tc, 0.01)) {
      issues.push({ code: "TOTALS_DO_NOT_RECONCILE", detail: "Available Cash + Emergency Cash does not equal Total Cash." });
    }
    const ta = num("totalAssets");
    const tl = num("totalLiabilities");
    const nw = num("netWorth");
    if (ta && tl && nw && !nearlyEqual(ta.minus(tl), nw, 0.01)) {
      issues.push({ code: "TOTALS_DO_NOT_RECONCILE", detail: "Assets minus liabilities does not equal net worth." });
    }
    const cur = num("currentMonthlyCashLeft");
    const sc = num("scenarioMonthlyCashLeft");
    const md = num("monthlyDifference");
    const yd = num("twelveMonthDifference");
    if (cur && sc && md && !nearlyEqual(sc.minus(cur).abs(), md, 0.01)) {
      issues.push({ code: "TOTALS_DO_NOT_RECONCILE", detail: "Scenario cash difference does not match current vs scenario cash." });
    }
    if (md && yd && !nearlyEqual(md.times(12), yd, 0.12)) {
      issues.push({ code: "TOTALS_DO_NOT_RECONCILE", detail: "Twelve-month difference is not twelve times the monthly difference." });
    }
  }

  // 4. Basis labelling (ACTUAL needs no label).
  for (const t of tools) {
    const label = BASIS_LABEL[t.basis];
    if (label && !label.test(text)) {
      issues.push({ code: "BASIS_NOT_LABELED", detail: `Facts are ${t.basis} but the answer does not say so.` });
    }
  }

  // 5. Period consistency, kept deliberately simple.
  const periods = new Set(tools.map((t) => t.period));
  if (/\bthis month\b/i.test(text) && !periods.has("MONTHLY")) {
    issues.push({ code: "PERIOD_MISMATCH", detail: "Answer says 'this month' but no monthly facts were used." });
  }
  if (/\b(this year|per year|annual(ly)?|yearly)\b/i.test(text) && !periods.has("YEARLY") && !/twelve|12-month|12 month/i.test(text)) {
    issues.push({ code: "PERIOD_MISMATCH", detail: "Answer speaks about a year but no yearly facts were used." });
  }

  return { passed: issues.length === 0, issues };
}
