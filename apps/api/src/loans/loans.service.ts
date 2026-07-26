import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";
import { SimulateAmortizationDto } from "./dto/simulate-amortization.dto";

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
// month), matching how `computeSchedule()` already numbers its rows.
export interface RateChange {
  effectiveFromMonth: number;
  newAnnualRatePercent: number;
}

@Injectable()
export class LoansService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
  ) {}

  list(userId: string) {
    return this.prisma.client.loan.findMany({
      where: { userId },
      orderBy: { outstandingPrincipal: "desc" },
    });
  }

  async create(userId: string, dto: CreateLoanDto) {
    return this.prisma.client.loan.create({
      data: { ...dto, userId, startDate: new Date(dto.startDate) },
    });
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to Income/Expenses/Investments: closes the TOCTOU gap
  // between "check ownership" and "perform the write," and collapses a cross-user
  // access attempt and a nonexistent id into the same 404 rather than leaking which
  // case occurred via a 403/404 split.
  async update(userId: string, id: string, dto: UpdateLoanDto) {
    const result = await this.prisma.client.loan.updateMany({
      where: { id, userId },
      data: { ...dto, startDate: dto.startDate ? new Date(dto.startDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Loan not found");
    }

    // updateMany() only returns a count; fetch the row to keep returning the updated
    // record, matching the original method's contract.
    return this.prisma.client.loan.findUnique({ where: { id } });
  }

  // Same atomic-ownership approach, and a genuine round-trip reduction: one
  // deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's loans page
  // (api.loans.remove(id)'s response is never read; it always re-fetches the list
  // afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.loan.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Loan not found");
    }

    return { id };
  }

  // Left arithmetically and structurally unchanged from the original implementation —
  // this method (and totalOutstanding() below) is consumed directly by Dashboard,
  // Household, Reports, Alerts, the Agentic Coach's data gatherer, ML Insights, and
  // Scenario Studio's expander, all of which assume today's exact numeric output and
  // shape.
  async debtSummary(userId: string) {
    const loans = await this.list(userId);
    const totalOutstanding = loans.reduce((sum, l) => sum + Number(l.outstandingPrincipal), 0);
    const totalMonthlyEmi = loans.reduce((sum, l) => sum + Number(l.emiAmount), 0);
    const monthlyIncome = await this.incomeService.monthlyForecast(userId);
    const debtStressScore = monthlyIncome > 0 ? Number(((totalMonthlyEmi / monthlyIncome) * 100).toFixed(1)) : 0;

    return {
      totalOutstanding: totalOutstanding.toFixed(2),
      totalMonthlyEmi: totalMonthlyEmi.toFixed(2),
      debtStressScore,
      loans,
    };
  }

  async totalOutstanding(userId: string): Promise<number> {
    const loans = await this.list(userId);
    return loans.reduce((sum, l) => sum + Number(l.outstandingPrincipal), 0);
  }

  // Standard reducing-balance amortization schedule, computed from the loan's current
  // outstanding principal, rate, and EMI (not from the original principal/tenure — this
  // reflects "where the loan stands today"). Unchanged in behavior: no rate changes, so
  // this is identical to before floating-rate support was added below.
  async amortizationSchedule(userId: string, loanId: string): Promise<AmortizationRow[]> {
    const loan = await this.getOwned(userId, loanId);
    return this.computeSchedule(
      Number(loan.outstandingPrincipal),
      Number(loan.interestRateAnnual),
      Number(loan.emiAmount),
    );
  }

  // NEW: "what if my rate changes" / "what if I prepay while my rate is also changing"
  // simulation — the audit's explicitly-recommended next step for this feature ("extend
  // computeSchedule to accept a floating-rate schedule... since Indian home loans are
  // commonly floating-rate — currently assumes a single fixed rate for the whole
  // remaining tenure"). Entirely additive: this is a new method behind a new endpoint,
  // touching nothing any existing caller depends on.
  //
  // Modeling choice, stated explicitly: EMI is held constant across rate changes (the
  // same "EMI-constant" philosophy computeSchedule() already uses everywhere) — a rate
  // increase means more of each EMI goes to interest and the payoff takes longer (or, if
  // the new rate makes the EMI insufficient to cover interest at all, the existing
  // stuck-schedule safety branch reports that clearly, which is exactly the right signal
  // for "this rate increase would break your current EMI"). The alternative modeling —
  // recalculating EMI to preserve the original tenure — is a different, valid product
  // decision left for a future iteration; documented here rather than silently chosen.
  async simulateAmortization(
    userId: string,
    loanId: string,
    dto: SimulateAmortizationDto,
  ): Promise<AmortizationRow[]> {
    const loan = await this.getOwned(userId, loanId);
    const principal = Math.max(0, Number(loan.outstandingPrincipal) - (dto.lumpSumPrepayment ?? 0));
    return this.computeSchedule(
      principal,
      Number(loan.interestRateAnnual),
      Number(loan.emiAmount),
      dto.rateChanges ?? [],
    );
  }

  // Debt snowball (smallest balance first) or avalanche (highest interest rate first)
  // payoff ordering — a common decision-support view for users juggling multiple loans.
  async payoffOrder(userId: string, strategy: "snowball" | "avalanche") {
    const loans = await this.list(userId);
    const sorted = [...loans].sort((a, b) =>
      strategy === "snowball"
        ? Number(a.outstandingPrincipal) - Number(b.outstandingPrincipal)
        : Number(b.interestRateAnnual) - Number(a.interestRateAnnual),
    );
    return sorted.map((loan, index) => ({ priority: index + 1, loan }));
  }

  // Applies a one-time lump sum to reduce principal, keeps the EMI the same, and reports
  // how many months and how much interest are saved versus the current payoff schedule.
  //
  // `rateChanges` is a new, OPTIONAL 4th parameter defaulting to `[]` — every existing
  // caller (this feature's own GET /loans/:id/prepayment-impact controller route, and
  // critically SimulatorService's LOAN_PREPAYMENT scenario, which calls this with only 3
  // arguments) gets `rateChanges = []`, which produces byte-for-byte identical output to
  // before this change (see computeSchedule() below — an empty rate-change list is a
  // guaranteed no-op). The same future rate path is applied to BOTH the baseline and
  // with-prepayment schedules, so the comparison stays apples-to-apples: it isolates the
  // effect of the prepayment itself, answering "does prepaying still help if my rate also
  // rises next year" rather than conflating the two effects.
  async prepaymentImpact(userId: string, loanId: string, lumpSum: number, rateChanges: RateChange[] = []) {
    const loan = await this.getOwned(userId, loanId);
    const principal = Number(loan.outstandingPrincipal);
    const rate = Number(loan.interestRateAnnual);
    const emi = Number(loan.emiAmount);

    const baseline = this.computeSchedule(principal, rate, emi, rateChanges);
    const withPrepayment = this.computeSchedule(Math.max(0, principal - lumpSum), rate, emi, rateChanges);

    const baselineInterest = baseline.reduce((sum, r) => sum + r.interest, 0);
    const newInterest = withPrepayment.reduce((sum, r) => sum + r.interest, 0);

    return {
      monthsSaved: baseline.length - withPrepayment.length,
      interestSaved: Number((baselineInterest - newInterest).toFixed(2)),
      originalTenureMonths: baseline.length,
      newTenureMonths: withPrepayment.length,
    };
  }

  private computeSchedule(
    principal: number,
    annualRatePercent: number,
    emi: number,
    rateChanges: RateChange[] = [],
  ): AmortizationRow[] {
    // Sorted ascending once, up front, so applying changes during the simulation is a
    // simple linear scan bounded by rateChanges.length — realistically a handful of
    // resets over a loan's lifetime, not a performance concern. An empty array here
    // (the default, and every pre-existing call site's effective input) means the `while`
    // below never executes, so `currentRate` never changes from `annualRatePercent` —
    // this is what guarantees zero behavioral drift for every caller that doesn't opt
    // into this feature.
    const sortedChanges = [...rateChanges].sort((a, b) => a.effectiveFromMonth - b.effectiveFromMonth);

    const rows: AmortizationRow[] = [];
    let balance = principal;
    let month = 0;
    let currentRate = annualRatePercent;
    const maxMonths = 600; // safety cap (50 years) against a misconfigured EMI that never pays down principal

    while (balance > 0 && month < maxMonths) {
      month += 1;

      // `while`, not `if`: if two rate changes were specified for the same month, the
      // last one in array order wins (array order = intent order), rather than an
      // arbitrary pick.
      while (sortedChanges.length > 0 && sortedChanges[0].effectiveFromMonth <= month) {
        currentRate = sortedChanges.shift()!.newAnnualRatePercent;
      }

      const monthlyRate = currentRate / 12 / 100;
      const interest = balance * monthlyRate;
      let principalPaid = emi - interest;
      if (principalPaid <= 0) {
        // EMI doesn't even cover interest — schedule cannot converge. Record this month
        // (balance unchanged, the whole EMI is absorbed by interest) so callers always
        // get a non-empty schedule reflecting the stuck state, then stop. This is also
        // exactly what happens if a rate increase pushes interest above the fixed EMI —
        // see the modeling note on simulateAmortization() above.
        rows.push({
          month,
          emi: Number(emi.toFixed(2)),
          interest: Number(interest.toFixed(2)),
          principal: 0,
          balance: Number(balance.toFixed(2)),
        });
        break;
      }
      if (principalPaid > balance) principalPaid = balance;
      balance = Math.max(0, balance - principalPaid);
      rows.push({
        month,
        emi: Number((principalPaid + interest).toFixed(2)),
        interest: Number(interest.toFixed(2)),
        principal: Number(principalPaid.toFixed(2)),
        balance: Number(balance.toFixed(2)),
      });
    }

    return rows;
  }

  private async getOwned(userId: string, loanId: string) {
    const loan = await this.prisma.client.loan.findUnique({ where: { id: loanId } });
    if (!loan || loan.userId !== userId) throw new NotFoundException("Loan not found");
    return loan;
  }
}
