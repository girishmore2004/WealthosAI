import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { IncomeService } from "../income/income.service";
import { CreateLoanDto } from "./dto/create-loan.dto";
import { UpdateLoanDto } from "./dto/update-loan.dto";

interface AmortizationRow {
  month: number;
  emi: number;
  interest: number;
  principal: number;
  balance: number;
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

  async update(userId: string, id: string, dto: UpdateLoanDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.loan.update({
      where: { id },
      data: { ...dto, startDate: dto.startDate ? new Date(dto.startDate) : undefined },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.loan.delete({ where: { id } });
  }

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
  // reflects "where the loan stands today").
  async amortizationSchedule(userId: string, loanId: string): Promise<AmortizationRow[]> {
    const loan = await this.getOwned(userId, loanId);
    return this.computeSchedule(
      Number(loan.outstandingPrincipal),
      Number(loan.interestRateAnnual),
      Number(loan.emiAmount),
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
  async prepaymentImpact(userId: string, loanId: string, lumpSum: number) {
    const loan = await this.getOwned(userId, loanId);
    const principal = Number(loan.outstandingPrincipal);
    const rate = Number(loan.interestRateAnnual);
    const emi = Number(loan.emiAmount);

    const baseline = this.computeSchedule(principal, rate, emi);
    const withPrepayment = this.computeSchedule(Math.max(0, principal - lumpSum), rate, emi);

    const baselineInterest = baseline.reduce((sum, r) => sum + r.interest, 0);
    const newInterest = withPrepayment.reduce((sum, r) => sum + r.interest, 0);

    return {
      monthsSaved: baseline.length - withPrepayment.length,
      interestSaved: Number((baselineInterest - newInterest).toFixed(2)),
      originalTenureMonths: baseline.length,
      newTenureMonths: withPrepayment.length,
    };
  }

  private computeSchedule(principal: number, annualRatePercent: number, emi: number): AmortizationRow[] {
    const monthlyRate = annualRatePercent / 12 / 100;
    const rows: AmortizationRow[] = [];
    let balance = principal;
    let month = 0;
    const maxMonths = 600; // safety cap (50 years) against a misconfigured EMI that never pays down principal

    while (balance > 0 && month < maxMonths) {
      month += 1;
      const interest = balance * monthlyRate;
      let principalPaid = emi - interest;
      if (principalPaid <= 0) break; // EMI doesn't even cover interest — schedule cannot converge
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
    if (!loan) throw new NotFoundException("Loan not found");
    if (loan.userId !== userId) throw new ForbiddenException();
    return loan;
  }

  private async assertOwnership(userId: string, loanId: string) {
    await this.getOwned(userId, loanId);
  }
}
