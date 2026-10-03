import { CalculationMetric, RoutedIntent, ScenarioParams } from "./financial-types";

// Deterministic, rule-based intent router. No model call: routing must be reproducible and
// auditable, and it decides whether a question is answered from authoritative tools,
// handed to RAG/the legacy coach, or treated as general education.
//
// Order matters — more specific intents are tested before broader ones (e.g. a question
// about what a policy DOCUMENT says is a document query even though it mentions insurance).

const has = (q: string, re: RegExp) => re.test(q);

/** Parses ₹5,000 / rs 5000 / 5k / 1.5 lakh / 2 crore into a positive decimal string, or null. */
export function parseRupeeAmount(text: string): string | null {
  const m = text.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|thousand|lakhs?|lacs?|crores?|cr)?\b/i);
  if (!m) return null;
  // Require either a currency marker or a unit/size word so a bare "3 months" is not an amount.
  const hasMarker = /(?:₹|rs\.?|inr)/i.test(m[0]) || m[2] !== undefined || /\b(by|of|to)\s*₹?\s*\d[\d,]{3,}/i.test(text);
  if (!hasMarker) return null;
  const base = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(base) || base <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "k" || unit === "thousand" ? 1_000 : unit.startsWith("lakh") || unit.startsWith("lac") ? 100_000 : unit.startsWith("cr") ? 10_000_000 : 1;
  return (base * mult).toFixed(2);
}

function parsePercent(text: string): string | null {
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? m[1] : null;
}

function scenarioParams(q: string): ScenarioParams {
  const decrease = has(q, /\b(decrease|reduce|cut|lower|drop|less|reduction|decline)\b/);
  const direction = decrease ? "DECREASE" : "INCREASE";
  let kind: ScenarioParams["kind"] = "UNSUPPORTED";
  if (has(q, /\b(sip|monthly investment|investment amount|invest more|invest less)\b/)) kind = "SIP_CHANGE";
  else if (has(q, /\b(salary|income|raise|hike|pay cut|pay)\b/)) kind = "SALARY_CHANGE";
  else if (has(q, /\b(expenses?|spending|rent|spend)\b/)) kind = "EXPENSE_CHANGE";
  // Things the pure planner does not model are left to Scenario Studio.
  if (has(q, /\b(prepay|prepayment|retire|retirement|loan|emi|insurance|premium|goal|house|car)\b/) && kind !== "SIP_CHANGE") {
    kind = "UNSUPPORTED";
  }
  const percent = parsePercent(q);
  return { kind, direction, amount: percent ? null : parseRupeeAmount(q), percent };
}

function metricFor(q: string): CalculationMetric | undefined {
  if (has(q, /\bsavings? rate\b/)) return "SAVINGS_RATE";
  if (has(q, /\binvest(ment)? rate\b/)) return "INVESTMENT_RATE";
  if (has(q, /\bhow much (did|have|do) i (invest|put into investments|contribute)/)) return "INVESTED";
  if (has(q, /\bhow much (did|have|do) i (spend|spent)/)) return "SPENT";
  if (has(q, /\bhow much (did|have|do) i (earn|make|receive|get paid)/)) return "EARNED";
  return undefined;
}

export function routeIntent(question: string): RoutedIntent {
  const q = question.toLowerCase().trim();

  if (has(q, /\bwhat (happens|would happen|will happen)\b|\bwhat if\b|\bif i (increase|decrease|raise|cut|reduce|lower|get a (raise|hike))\b|\bsuppose\b/)) {
    return { intent: "SCENARIO", scenario: scenarioParams(q) };
  }
  if (has(q, /\bwhat does (my|the) .{0,40}\b(say|state|mention)\b|\b(policy|document|statement|passbook|agreement|letter|receipt)\b.{0,40}\b(says?|states?|mentions?|clause|terms?)\b|\bclause\b/)) {
    return { intent: "DOCUMENT_QUERY" };
  }
  if (has(q, /\b(last|recent|latest) (transactions?|expenses?|payments?)\b|\bshow (me )?(my )?(transactions|expenses)\b|\bwhen did i (pay|buy|spend)\b/)) {
    return { intent: "TRANSACTION_QUERY" };
  }

  const metric = metricFor(q);
  if (metric) return { intent: "FINANCIAL_CALCULATION", metric };

  if (has(q, /\bemergency (fund|cash|reserve|coverage)\b|\bmonths? of (expenses|coverage)\b|\bemergency\b/)) return { intent: "EMERGENCY_FUND" };
  if (has(q, /\bnet worth\b/)) return { intent: "NET_WORTH" };
  if (has(q, /\b(cash ?flow|available cash|total cash|how much cash)\b/)) return { intent: "CASH_FLOW" };
  if (has(q, /\b(insurance|premium|policy|policies)\b/)) return { intent: "INSURANCE" };
  if (has(q, /\b(loan|emi|mortgage|debt|outstanding)\b/)) return { intent: "LOAN" };
  if (has(q, /\bretire(ment)?\b|\bcorpus\b|\bepf\b|\bnps\b|\bppf\b/) && !has(q, /\bhow much (did|have) i\b/)) return { intent: "RETIREMENT" };
  if (has(q, /\bgoals?\b/)) return { intent: "GOAL" };
  if (has(q, /\b(tax|80c|80d|itr|deduction)\b/)) return { intent: "TAX" };
  if (has(q, /\b(invest(ed|ment|ments)?|sip|portfolio|mutual funds?|stocks?)\b/)) return { intent: "INVESTMENT_ANALYSIS" };
  if (has(q, /\b(expenses?|spending|spent)\b/)) return { intent: "EXPENSE_ANALYSIS" };
  if (has(q, /\b(income|salary|earn(ed|ing)?)\b/)) return { intent: "INCOME_ANALYSIS" };
  if (has(q, /\b(plan|how (should|can|do) i|strategy|roadmap)\b/)) return { intent: "PLANNING" };
  if (has(q, /\b(summary|overview|how am i doing|financial health|snapshot)\b/)) return { intent: "FINANCIAL_SUMMARY" };
  return { intent: "GENERAL_FINANCIAL_EDUCATION" };
}
