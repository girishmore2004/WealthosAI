import { formatINR } from "../../../common/utils/currency.util";
import { maskIdentifier } from "../../../common/utils/mask.util";

// Builds the FINANCIAL_FACT sources the RAG index holds about the user's OWN records. Pure
// function of plain rows: no database access, so what gets indexed is testable and every
// source is derived from authoritative data (never from a model).
//
// Every source carries { entityType, entityId, factType } in metadata so retrieval can scope by
// record, and so documents linked to the same record can be related to it in the index graph.
// Identifiers are masked here AND the indexing service passes all text through redaction.

export interface FactSource {
  sourceType: "FINANCIAL_FACT";
  sourceId: string;
  text: string;
  metadata: Record<string, unknown>;
  sourceCreatedAt: Date;
}

export interface FactSourceInput {
  position: { netWorth: string; totalAssets: string; totalLiabilities: string; cash: { available: string; emergency: string; total: string }; investmentValue: string; property: string; loans: string };
  cashFlow: { month: string; income: string; expenses: string; investmentContributions: string; emergencyAllocations: string };
  emergency: { emergencyCash: string; coverageMonths: string | null; avgMonthlyEssentialExpenses: string };
  policies: Array<{ id: string; provider: string; type: string; premiumAmount: string; premiumFrequency: string; coverageAmount: string; renewalDate: Date; nomineeName: string | null; policyNumber: string | null }>;
  investments: Array<{ id: string; name: string; type: string; currentValue: string; valuedAt: Date | null; contributions: string; withdrawals: string; sipActive: boolean; monthlyContribution: string | null }>;
  loans: Array<{ id: string; lender: string; type: string; outstandingPrincipal: string; emiAmount: string; interestRateAnnual: string }>;
  dataHealth: Array<{ code: string; message: string; count: number; amount?: string }>;
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const lower = (s: string) => s.toLowerCase().replace(/_/g, " ");

export function buildFinancialFactSources(input: FactSourceInput, today: Date): FactSource[] {
  const stamp = day(today);
  const out: FactSource[] = [];
  const add = (sourceId: string, factType: string, title: string, text: string, entity?: { entityType: string; entityId: string }) =>
    out.push({
      sourceType: "FINANCIAL_FACT",
      sourceId,
      text,
      metadata: { title, factType, ...(entity ?? {}) },
      sourceCreatedAt: today,
    });

  const p = input.position;
  const c = input.cashFlow;
  add(
    `summary:${stamp}`,
    "SUMMARY",
    "Financial summary",
    `Financial summary as of ${stamp} (actual, from your records). Net worth ${formatINR(p.netWorth)}: assets ${formatINR(p.totalAssets)} minus liabilities ${formatINR(p.totalLiabilities)}. ` +
      `Available cash ${formatINR(p.cash.available)}, emergency cash ${formatINR(p.cash.emergency)}, total cash ${formatINR(p.cash.total)}. ` +
      `Investments ${formatINR(p.investmentValue)}, property ${formatINR(p.property)}, loans outstanding ${formatINR(p.loans)}. ` +
      `For ${c.month}: income ${formatINR(c.income)}, actual spending ${formatINR(c.expenses)}, invested ${formatINR(c.investmentContributions)}, moved to emergency reserve ${formatINR(c.emergencyAllocations)}.`,
  );

  const e = input.emergency;
  add(
    "EMERGENCY_FUND:summary",
    "EMERGENCY_FUND",
    "Emergency fund",
    `Emergency fund: ${formatINR(e.emergencyCash)} of reserved cash` +
      (e.coverageMonths !== null ? `, covering about ${Number(e.coverageMonths).toFixed(1)} months of essential expenses (average ${formatINR(e.avgMonthlyEssentialExpenses)} per month).` : `. Coverage cannot be calculated because no essential expenses are recorded in recent complete months.`),
    { entityType: "EMERGENCY_FUND", entityId: "summary" },
  );

  for (const pol of input.policies) {
    add(
      `POLICY:${pol.id}`,
      "POLICY",
      `${pol.provider} ${lower(pol.type)} policy`,
      `Insurance policy: ${pol.provider} ${lower(pol.type)}, policy number ${maskIdentifier(pol.policyNumber)}. Premium ${formatINR(pol.premiumAmount)} paid ${lower(pol.premiumFrequency)}. ` +
        `Coverage ${formatINR(pol.coverageAmount)}. Renewal date ${day(pol.renewalDate)}. Nominee: ${pol.nomineeName ?? "not recorded"}.`,
      { entityType: "POLICY", entityId: pol.id },
    );
  }

  for (const inv of input.investments) {
    add(
      `INVESTMENT:${inv.id}`,
      "INVESTMENT",
      `${inv.name} (${lower(inv.type)})`,
      `Investment: ${inv.name} (${lower(inv.type)}). Current value ${formatINR(inv.currentValue)}${inv.valuedAt ? ` as of ${day(inv.valuedAt)}` : " (legacy value, no dated valuation)"}. ` +
        `Contributions to date ${formatINR(inv.contributions)}, withdrawals ${formatINR(inv.withdrawals)}. ` +
        (inv.sipActive && inv.monthlyContribution ? `Active monthly SIP of ${formatINR(inv.monthlyContribution)}.` : "No active recurring contribution."),
      { entityType: "INVESTMENT", entityId: inv.id },
    );
  }

  for (const loan of input.loans) {
    add(
      `LOAN:${loan.id}`,
      "LOAN",
      `${loan.lender} ${lower(loan.type)} loan`,
      `Loan: ${loan.lender} ${lower(loan.type)}. Outstanding principal ${formatINR(loan.outstandingPrincipal)}, EMI ${formatINR(loan.emiAmount)} per month at ${Number(loan.interestRateAnnual).toFixed(2)}% annual interest.`,
      { entityType: "LOAN", entityId: loan.id },
    );
  }

  add(
    `datahealth:${stamp}`,
    "DATA_HEALTH",
    "Data health",
    input.dataHealth.length === 0
      ? `Data health as of ${stamp}: no inconsistencies were detected in your records.`
      : `Data health as of ${stamp}: ${input.dataHealth.map((w) => `${w.message}${w.amount ? ` (${formatINR(w.amount)})` : ""}`).join(" ")}`,
  );

  return out;
}
