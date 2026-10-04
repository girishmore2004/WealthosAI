import { formatINR } from "../../common/utils/currency.util";
import { Prisma } from "@wealthos/db";
import { RoutedIntent, ToolResult, ToolWarning } from "./financial-types";

// Deterministic answer composer. It only renders values that already exist in tool facts —
// it performs no arithmetic of its own, so any number it prints is a backend number. The
// numeric verifier independently re-checks the finished text.

const pct = (ratio: string): string => `${new Prisma.Decimal(ratio).times(100).toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toFixed(1)}%`;

function tool(tools: ToolResult[], name: string): ToolResult | undefined {
  return tools.find((t) => t.tool === name);
}
const m = (t: ToolResult | undefined, key: string): string | null => {
  const f = t?.facts[key];
  return f ? formatINR(f.value) : null;
};
const r = (t: ToolResult | undefined, key: string): string | null => {
  const f = t?.facts[key];
  return f ? pct(f.value) : null;
};

function dataHealthNote(tools: ToolResult[], relevant: string[]): string {
  const seen = new Map<string, ToolWarning>();
  for (const t of tools) for (const w of t.warnings) if (w.severity === "WARNING" && relevant.includes(w.code) && !seen.has(w.code)) seen.set(w.code, w);
  if (seen.size === 0) return "";
  const lines = [...seen.values()].map((w) => {
    const amt = w.amount !== undefined ? ` (${formatINR(w.amount)})` : "";
    if (w.code === "INVESTMENT_AS_EXPENSE") {
      return `I found ${w.count} investment/SIP entr${w.count === 1 ? "y" : "ies"}${amt} still recorded as expenses, so investment and spending totals may be off until they are reconciled.`;
    }
    if (w.code === "EMERGENCY_AS_EXPENSE") {
      return `I found ${w.count} emergency-fund entr${w.count === 1 ? "y" : "ies"}${amt} still recorded as expenses, so emergency cash may be understated until they are reconciled.`;
    }
    return `Data check: ${w.message}`;
  });
  return `\n\nHeads up: ${lines.join(" ")}`;
}

const MONEY_CODES = ["INVESTMENT_AS_EXPENSE", "EMERGENCY_AS_EXPENSE", "DUPLICATE_SALARY", "DUPLICATE_EXPENSE", "DUPLICATE_RECURRING_EVENT", "NEGATIVE_AVAILABLE_CASH", "POSSIBLE_BANK_DUPLICATE"];
const INVEST_CODES = ["INVESTMENT_AS_EXPENSE", "STALE_INVESTMENT_VALUATION", "MISSING_INVESTMENT_VALUATION", "INCONSISTENT_COST_BASIS"];
const INSURANCE_CODES = ["DUPLICATE_INSURANCE_PREMIUM", "MISSING_SOURCE_REFERENCE", "DOCUMENT_DISCREPANCY"];

function missingNote(tools: ToolResult[]): string {
  const missing = tools.flatMap((t) => t.missing);
  return missing.length ? ` I don't have enough recorded to work out: ${missing.join(", ")}.` : "";
}

export function composeAnswer(routed: RoutedIntent, tools: ToolResult[]): string {
  const cf = tool(tools, "getCashFlow");
  const pos = tool(tools, "getNetWorth") ?? tool(tools, "getFinancialFacts");

  switch (routed.intent) {
    case "FINANCIAL_CALCULATION": {
      switch (routed.metric) {
        case "INVESTED": {
          const invested = m(cf, "investmentContributions");
          const alloc = m(cf, "emergencyAllocations");
          const base = `This month you invested ${invested ?? "nothing recorded"} in actual investment contributions.`;
          const excl = alloc ? ` Emergency-fund allocations (${alloc}) and any SIP wrongly logged as an expense are not counted here.` : "";
          return base + excl + dataHealthNote(tools, INVEST_CODES) + missingNote(tools);
        }
        case "SPENT":
          return `This month you spent ${m(cf, "expenses") ?? "nothing recorded"} on actual expenses; SIPs, investments and emergency-fund transfers are not spending.` + dataHealthNote(tools, MONEY_CODES);
        case "EARNED":
          return `This month you received ${m(cf, "income") ?? "no income recorded"} in income.` + dataHealthNote(tools, MONEY_CODES);
        case "SAVINGS_RATE": {
          const rate = r(cf, "savingsRate");
          if (!rate) return "I can't compute a savings rate because no income has been recorded this month." + missingNote(tools);
          return `Your savings rate this month is ${rate}: ${m(cf, "income")} income received minus ${m(cf, "expenses")} of actual spending.` + dataHealthNote(tools, MONEY_CODES);
        }
        case "INVESTMENT_RATE": {
          const rate = r(cf, "investmentRate");
          if (!rate) return "I can't compute an investment rate because no income has been recorded this month." + missingNote(tools);
          return `Your investment rate this month is ${rate}: ${m(cf, "investmentContributions")} invested out of ${m(cf, "income")} income.` + dataHealthNote(tools, INVEST_CODES);
        }
        default:
          return "I couldn't tell which figure you want calculated.";
      }
    }

    case "NET_WORTH":
      return (
        `Your net worth is ${m(pos, "netWorth")}: assets of ${m(pos, "totalAssets")} ` +
        `(${m(pos, "availableCash")} available cash, ${m(pos, "emergencyCash")} emergency cash, ${m(pos, "investmentValue")} investments, ${m(pos, "property")} property) ` +
        `minus ${m(pos, "totalLiabilities")} in liabilities.` + dataHealthNote(tools, [...MONEY_CODES, ...INVEST_CODES])
      );

    case "CASH_FLOW":
      return (
        `Available cash is ${m(pos, "availableCash")}, emergency cash is ${m(pos, "emergencyCash")}, so total cash is ${m(pos, "totalCash")}. ` +
        `This month: ${m(cf, "income")} income, ${m(cf, "expenses")} spending, ${m(cf, "investmentContributions")} invested and ${m(cf, "emergencyAllocations")} moved to the emergency reserve.` +
        dataHealthNote(tools, MONEY_CODES)
      );

    case "EMERGENCY_FUND": {
      const ec = tool(tools, "calculateEmergencyCoverage");
      const months = ec?.facts.coverageMonths?.value;
      if (!months) {
        return `Your emergency cash is ${m(ec, "emergencyCash") ?? "not recorded"}, but I can't work out coverage because there are no essential expenses recorded in recent complete months.` + dataHealthNote(tools, MONEY_CODES);
      }
      return (
        `Your emergency cash of ${m(ec, "emergencyCash")} covers about ${new Prisma.Decimal(months).toDecimalPlaces(1).toFixed(1)} months of essential expenses ` +
        `(average ${m(ec, "avgMonthlyEssentialExpenses")} per month).` + dataHealthNote(tools, ["EMERGENCY_AS_EXPENSE"])
      );
    }

    case "INVESTMENT_ANALYSIS": {
      const inv = tool(tools, "getInvestmentSummary");
      return (
        `Your investments are currently worth ${m(inv, "investmentValue")}. You have contributed ${m(inv, "lifetimeContributions")} in total and withdrawn ${m(inv, "lifetimeWithdrawals")}; ` +
        `${m(inv, "monthContributions")} went in this month.` + dataHealthNote(tools, INVEST_CODES)
      );
    }

    case "EXPENSE_ANALYSIS":
      return `This month your actual spending is ${m(cf, "expenses") ?? "nothing recorded"}${r(cf, "expenseRate") ? `, which is ${r(cf, "expenseRate")} of your income` : ""}.` + dataHealthNote(tools, MONEY_CODES);

    case "INCOME_ANALYSIS":
      return `This month you received ${m(cf, "income") ?? "no income recorded"}.` + dataHealthNote(tools, ["DUPLICATE_SALARY", "DUPLICATE_RECURRING_EVENT"]);

    case "FINANCIAL_SUMMARY":
      return (
        `Net worth is ${m(pos, "netWorth")}, with ${m(pos, "totalCash")} in total cash (${m(pos, "availableCash")} available, ${m(pos, "emergencyCash")} emergency). ` +
        `This month: ${m(cf, "income")} income, ${m(cf, "expenses")} spending, ${m(cf, "investmentContributions")} invested` +
        `${r(cf, "savingsRate") ? `; savings rate ${r(cf, "savingsRate")}, investment rate ${r(cf, "investmentRate")}` : ""}.` + dataHealthNote(tools, MONEY_CODES)
      );

    case "INSURANCE": {
      const ins = tool(tools, "getInsuranceSummary");
      if (!ins || (ins.facts.policyCount?.value ?? "0") === "0") return "You don't have any insurance policies recorded.";
      const lines = (ins.rows ?? []).map((row) => `${row.label}: ${formatINR(row.facts.premium.value)} premium`);
      return `You have ${ins.facts.policyCount.value} polic${ins.facts.policyCount.value === "1" ? "y" : "ies"} with ${m(ins, "totalPremiumsRecorded")} in premiums recorded so far. ${lines.join("; ")}.` + dataHealthNote(tools, INSURANCE_CODES);
    }

    case "LOAN": {
      const ln = tool(tools, "getLoanSummary");
      if (!ln || ln.facts.outstanding.value === "0.00") return "You don't have any loans recorded.";
      return `Your loans total ${m(ln, "outstanding")} outstanding, with monthly EMIs of ${m(ln, "monthlyEmi")}${r(ln, "debtToIncome") ? `, which is ${r(ln, "debtToIncome")} of your monthly income` : ""}.`;
    }

    case "SCENARIO": {
      const sc = tool(tools, "calculateScenario");
      if (!sc) // Deliberately contains no figure: any number in an answer must come from a backend fact.
      return "I need a specific amount or a percentage to run that scenario, for example by stating how many rupees you would add to your SIP.";
      const kind = routed.scenario?.kind;
      const verb = routed.scenario?.direction === "DECREASE" ? "decrease" : "increase";
      const what = kind === "SIP_CHANGE" ? "your SIP" : kind === "SALARY_CHANGE" ? "your income" : "your monthly spending";
      const lessMore = new Prisma.Decimal(sc.facts.scenarioMonthlyCashLeft.value).lt(sc.facts.currentMonthlyCashLeft.value) ? "less" : "more";
      return (
        `Scenario (projected, nothing was changed): if you ${verb} ${what} by ${m(sc, "changeAmount")}, your monthly cash left after spending, investing and reserve transfers goes from ` +
        `${m(sc, "currentMonthlyCashLeft")} to ${m(sc, "scenarioMonthlyCashLeft")} — ${m(sc, "monthlyDifference")} ${lessMore} each month, ${m(sc, "twelveMonthDifference")} over twelve months. ` +
        `${kind === "SIP_CHANGE" ? `Your monthly contributions would move from ${m(sc, "currentContributions")} to ${m(sc, "scenarioContributions")}. ` : ""}` +
        `${r(sc, "currentSavingsRate") && r(sc, "scenarioSavingsRate") ? `Savings rate: ${r(sc, "currentSavingsRate")} now, ${r(sc, "scenarioSavingsRate")} in this scenario. ` : ""}` +
        `This is based on this month's actual ${m(sc, "currentIncome")} income, ${m(sc, "currentExpenses")} spending and ${m(sc, "emergencyAllocations")} emergency allocation.` +
        (sc.warnings.some((w) => w.code === "SCENARIO_NOTE") ? ` ${sc.warnings.filter((w) => w.code === "SCENARIO_NOTE").map((w) => w.message).join(" ")}` : "") +
        dataHealthNote(tools, MONEY_CODES)
      );
    }

    default:
      return "";
  }
}

/** Plain, always-verifiable rendering of the raw facts, used when verification fails. */
export function renderRawFacts(tools: ToolResult[]): string {
  const lines: string[] = [];
  for (const t of tools) {
    for (const [k, v] of Object.entries(t.facts)) {
      const shown = v.kind === "MONEY" ? formatINR(v.value) : v.kind === "RATIO" ? pct(v.value) : v.value;
      lines.push(`${k}: ${shown}`);
    }
  }
  return lines.join("\n");
}
