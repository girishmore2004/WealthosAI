// PURE MODULE — no Prisma, no service calls, no I/O of any kind, importable from both
// an injectable Nest service (LoansService) and a pure engine module
// (simulator.engine.ts) that cannot depend on anything Nest-injectable.
//
// Audit item #15: "simulator.engine.ts duplicates LoansService's private
// computeSchedule() logic ... two independent implementations of the same formula that
// must be kept in sync by hand." This file is the fix — the single shared
// implementation of the EMI-constant, reducing-balance amortization step. Both
// LoansService (building a full per-loan schedule for the Amortization page) and
// simulator.engine.ts (advancing every loan by one month inside a 5-year projection)
// now call the same `amortizeOneMonth()` primitive instead of each having their own
// copy of "interest = balance × monthlyRate; principalPaid = emi − interest."

export interface AmortizationRow {
  month: number;
  emi: number;
  interest: number;
  principal: number;
  balance: number;
}

// A future rate reset — e.g. an Indian floating-rate home loan's rate moving with
// RBI repo-rate changes. `effectiveFromMonth` is 1-indexed against the schedule being
// computed (month 1 = the first month of that particular simulation, not a calendar
// month).
export interface RateChange {
  effectiveFromMonth: number;
  newAnnualRatePercent: number;
}

export interface AmortizationStepResult {
  interest: number;
  principalPaid: number;
  newBalance: number;
  // true when this EMI doesn't even cover the interest due — the schedule cannot
  // converge at this rate/EMI combination. The caller decides how to represent that
  // (LoansService.computeSchedule() records one final "stuck" row and stops;
  // simulator.engine's stepLoansOneMonth() holds the loan's balance flat and keeps
  // going, since other loans in the portfolio may still be amortizing normally).
  stuck: boolean;
}

// Advances a single loan balance by exactly one month: interest = balance × monthlyRate;
// principalPaid = emi − interest. Deliberately returns RAW (unrounded) numbers —
// rounding is a per-caller display concern (LoansService rounds each row to 2dp for the
// Amortization page; simulator.engine.ts intentionally accumulates unrounded values
// across up to 60 months and only rounds the final projected net worth, to avoid
// compounding rounding error over the projection window).
export function amortizeOneMonth(balance: number, annualRatePercent: number, emi: number): AmortizationStepResult {
  const monthlyRate = annualRatePercent / 12 / 100;
  const interest = balance * monthlyRate;
  let principalPaid = emi - interest;

  if (principalPaid <= 0) {
    // EMI doesn't cover interest — stuck. Balance doesn't shrink; the full EMI (in the
    // schedule-building caller's case) or nothing further (in the portfolio-stepping
    // caller's case, which adds the EMI to its own outflow total itself) is absorbed
    // by interest.
    return { interest, principalPaid: 0, newBalance: balance, stuck: true };
  }

  if (principalPaid >= balance) {
    // final, partial month — the EMI more than covers what's left. Cap the total
    // cash applied (interest + principal) at the outstanding balance so the loan
    // closes out exactly, rather than crediting/debiting an extra `interest` worth
    // of principal beyond what's actually owed.
    principalPaid = balance - interest;
    return { interest, principalPaid, newBalance: 0, stuck: false };
  }
  return { interest, principalPaid, newBalance: balance - principalPaid, stuck: false };
}

// Full month-by-month schedule for a single loan, supporting an optional future
// rate-change path. This is LoansService's previously-private computeSchedule(),
// unchanged in behavior, now built on the shared amortizeOneMonth() primitive.
export function computeAmortizationSchedule(
  principal: number,
  annualRatePercent: number,
  emi: number,
  rateChanges: RateChange[] = [],
  maxMonths = 600, // safety cap (50 years) against a misconfigured EMI that never pays down principal
): AmortizationRow[] {
  // Sorted ascending once, up front, so applying changes during the simulation is a
  // simple linear scan bounded by rateChanges.length. An empty array (the default, and
  // every pre-existing call site's effective input) means `currentRate` never changes
  // from `annualRatePercent` — this is what guarantees zero behavioral drift for every
  // caller that doesn't opt into floating-rate simulation.
  const sortedChanges = [...rateChanges].sort((a, b) => a.effectiveFromMonth - b.effectiveFromMonth);

  const rows: AmortizationRow[] = [];
  let balance = principal;
  let month = 0;
  let currentRate = annualRatePercent;

  while (balance > 0 && month < maxMonths) {
    month += 1;

    // `while`, not `if`: if two rate changes were specified for the same month, the
    // last one in array order wins (array order = intent order), rather than an
    // arbitrary pick.
    while (sortedChanges.length > 0 && sortedChanges[0].effectiveFromMonth <= month) {
      currentRate = sortedChanges.shift()!.newAnnualRatePercent;
    }

    const step = amortizeOneMonth(balance, currentRate, emi);

    if (step.stuck) {
      // Record this month (balance unchanged, the whole EMI absorbed by interest) so
      // callers always get a non-empty schedule reflecting the stuck state, then stop.
      rows.push({
        month,
        emi: Number(emi.toFixed(2)),
        interest: Number(step.interest.toFixed(2)),
        principal: 0,
        balance: Number(balance.toFixed(2)),
      });
      break;
    }

    balance = step.newBalance;
    rows.push({
      month,
      emi: Number((step.principalPaid + step.interest).toFixed(2)),
      interest: Number(step.interest.toFixed(2)),
      principal: Number(step.principalPaid.toFixed(2)),
      balance: Number(balance.toFixed(2)),
    });
  }

  return rows;
}
