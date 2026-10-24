// PURE — no Prisma client, no I/O. The ONE place portfolio-level investment figures are derived from
// holdings, their ledger rows, latest valuations and realised gains. The Investments page and the Home
// dashboard both read the service that calls this, so they can never disagree.
//
// Definitions (kept deliberately explicit):
//   invested (cost basis) = contributions + employer contributions + transfers in  − cost basis realised by sales
//   unrealised gain       = current value − invested
//   total return          = current value + money taken out + dividends − fees − all money put in
//   return ratio          = total return ÷ all money put in (null when nothing was put in)
// A holding with NO inflow rows in the ledger has no history to derive any of this from, so its saved
// legacy cost basis is used instead and it is flagged (costBasisSource = "LEGACY"); it has no XIRR.

import { Prisma } from "@wealthos/db";
import type { InvestmentPortfolioDTO, PortfolioHoldingDTO } from "@wealthos/types";
import {
  CadenceName,
  CashflowType,
  addCashflow,
  annualContribution,
  emptyCashflowTotals,
  deriveInvestmentMetrics,
  monthlyEquivalent,
  percentOf,
  toDecimal,
  toMoneyString,
} from "../common/financial-facts/financial-formulas";
import { LedgerRow, SipStatus, financialYearLabel, financialYearStart, ledgerToFlows, sipStatusOf, xirr, XirrReason } from "./investment-returns.util";

type Dec = Prisma.Decimal;
const ZERO = new Prisma.Decimal(0);
/** Keep in step with STALE_VALUATION_DAYS in FinancialFactsService so "stale" means one thing everywhere. */
export const STALE_VALUATION_DAYS = 120;
const DAY_MS = 86_400_000;

export interface PortfolioHoldingInput {
  id: string;
  name: string;
  type: string;
  currentValue: Prisma.Decimal.Value; // legacy value saved on the holding
  costBasis: Prisma.Decimal.Value; // legacy cost basis saved on the holding
  purchaseDate: Date;
  sipActive: boolean;
  monthlyContribution: Prisma.Decimal.Value | null; // amount PER PERIOD
  contributionFrequency: string | null;
  contributionStartDate: Date | null;
  contributionEndDate: Date | null;
  sipCancelledAt: Date | null;
  latestValuation: { value: Prisma.Decimal.Value; valuedAt: Date } | null;
}

export interface PortfolioCashflowInput {
  investmentId: string;
  type: CashflowType;
  amount: Prisma.Decimal.Value;
  occurredAt: Date;
}

export interface PortfolioRealizedInput {
  investmentId: string;
  costBasisPortion: Prisma.Decimal.Value;
  gainAmount: Prisma.Decimal.Value;
}

const INFLOW: CashflowType[] = ["CONTRIBUTION", "EMPLOYER_CONTRIBUTION", "TRANSFER_IN"];
const pct = (ratio: Dec | null): string | null => (ratio === null ? null : ratio.toDecimalPlaces(6, Prisma.Decimal.ROUND_HALF_UP).toString());
const rateString = (r: number | null): string | null => (r === null ? null : r.toFixed(6));

export function buildPortfolio(
  holdings: PortfolioHoldingInput[],
  cashflows: PortfolioCashflowInput[],
  realized: PortfolioRealizedInput[],
  asOf: Date,
  currency = "INR",
): InvestmentPortfolioDTO {
  const rowsBy = new Map<string, PortfolioCashflowInput[]>();
  for (const c of cashflows) {
    const list = rowsBy.get(c.investmentId) ?? [];
    list.push(c);
    rowsBy.set(c.investmentId, list);
  }
  const realizedBy = new Map<string, { basis: Dec; gain: Dec }>();
  for (const r of realized) {
    const cur = realizedBy.get(r.investmentId) ?? { basis: ZERO, gain: ZERO };
    realizedBy.set(r.investmentId, { basis: cur.basis.plus(toDecimal(r.costBasisPortion)), gain: cur.gain.plus(toDecimal(r.gainAmount)) });
  }

  const monthPrefix = asOf.toISOString().slice(0, 7);
  const yearPrefix = asOf.toISOString().slice(0, 4);
  const fyStart = financialYearStart(asOf).getTime();
  const staleCutoff = asOf.getTime() - STALE_VALUATION_DAYS * DAY_MS;

  let totalInvested = ZERO;
  let grossIn = ZERO;
  let withdrawn = ZERO;
  let currentValue = ZERO;
  let unrealized = ZERO;
  let realizedTotal = ZERO;
  let dividends = ZERO;
  let fees = ZERO;
  let totalReturn = ZERO;
  let plannedMonthly = ZERO;
  let plannedAnnual = ZERO;
  let thisMonth = ZERO;
  let thisYear = ZERO;
  let thisFy = ZERO;
  const counts = { holdings: holdings.length, activeSips: 0, pausedSips: 0, endedSips: 0, oneTime: 0, staleValuations: 0, legacyCostBasis: 0 };
  const allFlows: ReturnType<typeof ledgerToFlows> = [];
  let xirrCovered = 0;
  const byType = new Map<string, Dec>();
  const out: PortfolioHoldingDTO[] = [];

  for (const h of holdings) {
    const rows = rowsBy.get(h.id) ?? [];
    const hasLedger = rows.some((r) => INFLOW.includes(r.type));

    let totals = emptyCashflowTotals();
    for (const r of rows) totals = addCashflow(totals, r.type, r.amount);

    const valued = h.latestValuation && h.latestValuation.valuedAt.getTime() <= asOf.getTime() ? h.latestValuation : null;
    const value = toDecimal(valued ? valued.value : h.currentValue);
    const freshness = valued ? (valued.valuedAt.getTime() < staleCutoff ? "STALE" : "FRESH") : "UNDATED";
    if (freshness !== "FRESH") counts.staleValuations += 1;

    const rz = realizedBy.get(h.id) ?? { basis: ZERO, gain: ZERO };

    let invested: Dec;
    let allIn: Dec;
    let unreal: Dec;
    let ret: Dec;
    let ratio: Dec | null;
    let taken: Dec;
    if (hasLedger) {
      const m = deriveInvestmentMetrics({ totals, currentValue: value, realizedCostBasisSold: rz.basis, realizedGain: rz.gain });
      allIn = totals.contributions.plus(totals.employerContributions).plus(totals.transfersIn);
      invested = m.costBasis;
      unreal = m.unrealizedGain;
      ret = m.totalReturn;
      ratio = m.returnPercentage;
      taken = totals.withdrawals.plus(totals.saleProceeds).plus(totals.transfersOut);
    } else {
      counts.legacyCostBasis += 1;
      allIn = toDecimal(h.costBasis);
      invested = allIn;
      unreal = value.minus(invested);
      ret = unreal.plus(totals.dividends).minus(totals.fees);
      ratio = allIn.isZero() ? null : ret.div(allIn);
      taken = ZERO;
    }

    // XIRR needs dated flows; a legacy holding with nothing recorded has none.
    let holdingXirr: { rate: number | null; reason: XirrReason } = { rate: null, reason: "NO_FLOWS" };
    if (hasLedger) {
      const ledgerRows: LedgerRow[] = rows.map((r) => ({ type: r.type, amount: toDecimal(r.amount).toNumber(), date: r.occurredAt }));
      const flows = ledgerToFlows(ledgerRows, value.toNumber(), asOf);
      holdingXirr = xirr(flows);
      allFlows.push(...flows);
      xirrCovered += 1;
    }

    // Own contributions by period (CONTRIBUTION only — employer money is not the user's cash).
    let hMonth = ZERO;
    let hYear = ZERO;
    let first: Date | null = null;
    for (const r of rows) {
      if (!INFLOW.includes(r.type)) continue;
      if (!first || r.occurredAt < first) first = r.occurredAt;
      if (r.type !== "CONTRIBUTION") continue;
      const iso = r.occurredAt.toISOString();
      const amt = toDecimal(r.amount);
      if (iso.startsWith(monthPrefix)) hMonth = hMonth.plus(amt);
      if (iso.startsWith(yearPrefix)) hYear = hYear.plus(amt);
      if (r.occurredAt.getTime() >= fyStart && r.occurredAt.getTime() <= asOf.getTime()) thisFy = thisFy.plus(amt);
    }
    thisMonth = thisMonth.plus(hMonth);
    thisYear = thisYear.plus(hYear);

    const hasSchedule = h.monthlyContribution !== null && h.contributionStartDate !== null;
    const status: SipStatus = sipStatusOf(
      { hasSchedule, active: h.sipActive, endDate: h.contributionEndDate, cancelledAt: h.sipCancelledAt },
      asOf,
    );
    let hPlannedMonthly: Dec | null = null;
    if (hasSchedule && status === "ACTIVE") {
      const cadence = ((h.contributionFrequency as CadenceName | null) ?? "MONTHLY") as CadenceName;
      const amount = toDecimal(h.monthlyContribution);
      hPlannedMonthly = monthlyEquivalent(amount, cadence);
      plannedMonthly = plannedMonthly.plus(hPlannedMonthly);
      plannedAnnual = plannedAnnual.plus(annualContribution(amount, cadence));
    }
    if (status === "ACTIVE") counts.activeSips += 1;
    else if (status === "PAUSED") counts.pausedSips += 1;
    else if (status === "CANCELLED" || status === "COMPLETED") counts.endedSips += 1;
    else counts.oneTime += 1;

    totalInvested = totalInvested.plus(invested);
    grossIn = grossIn.plus(allIn);
    withdrawn = withdrawn.plus(taken);
    currentValue = currentValue.plus(value);
    unrealized = unrealized.plus(unreal);
    realizedTotal = realizedTotal.plus(rz.gain);
    dividends = dividends.plus(totals.dividends);
    fees = fees.plus(totals.fees);
    totalReturn = totalReturn.plus(ret);
    byType.set(h.type, (byType.get(h.type) ?? ZERO).plus(value));

    out.push({
      id: h.id,
      name: h.name,
      type: h.type as PortfolioHoldingDTO["type"],
      invested: toMoneyString(invested),
      costBasisSource: hasLedger ? "LEDGER" : "LEGACY",
      currentValue: toMoneyString(value),
      valuedAt: valued ? valued.valuedAt.toISOString() : null,
      valuationSource: valued ? "VALUATION" : "LEGACY_CURRENT_VALUE",
      freshness,
      unrealizedGain: toMoneyString(unreal),
      realizedGain: toMoneyString(rz.gain),
      dividends: toMoneyString(totals.dividends),
      fees: toMoneyString(totals.fees),
      totalReturn: toMoneyString(ret),
      returnRatio: pct(ratio),
      xirr: rateString(holdingXirr.rate),
      sipStatus: status,
      plannedMonthly: hPlannedMonthly ? toMoneyString(hPlannedMonthly) : null,
      contributedThisMonth: toMoneyString(hMonth),
      contributedThisYear: toMoneyString(hYear),
      firstContributionDate: first ? first.toISOString() : null,
    });
  }

  const portfolioXirr = allFlows.length > 0 ? xirr(allFlows) : { rate: null, reason: "NO_FLOWS" as XirrReason };
  const overallRatio = grossIn.isZero() ? null : totalReturn.div(grossIn);

  const allocation = [...byType.entries()]
    .sort((a, b) => b[1].comparedTo(a[1]))
    .map(([type, value]) => {
      const p = percentOf(value, currentValue);
      return {
        type: type as InvestmentPortfolioDTO["allocation"][number]["type"],
        value: toMoneyString(value),
        percent: p === null ? 0 : Number(p.toDecimalPlaces(1, Prisma.Decimal.ROUND_HALF_UP).toString()),
      };
    });

  return {
    basis: "ACTUAL",
    asOfDate: asOf.toISOString(),
    currency,
    totals: {
      totalInvested: toMoneyString(totalInvested),
      grossContributed: toMoneyString(grossIn),
      withdrawn: toMoneyString(withdrawn),
      currentValue: toMoneyString(currentValue),
      unrealizedGain: toMoneyString(unrealized),
      realizedGain: toMoneyString(realizedTotal),
      dividends: toMoneyString(dividends),
      fees: toMoneyString(fees),
      totalReturn: toMoneyString(totalReturn),
      returnRatio: pct(overallRatio),
      xirr: rateString(portfolioXirr.rate),
      xirrReason: portfolioXirr.reason,
      xirrCoveredHoldings: xirrCovered,
    },
    contributions: {
      plannedMonthly: toMoneyString(plannedMonthly),
      plannedAnnual: toMoneyString(plannedAnnual),
      actualThisMonth: toMoneyString(thisMonth),
      actualThisCalendarYear: toMoneyString(thisYear),
      actualThisFinancialYear: toMoneyString(thisFy),
      financialYear: financialYearLabel(asOf),
    },
    counts,
    allocation,
    holdings: out.sort((a, b) => Number(b.currentValue) - Number(a.currentValue)),
  };
}
