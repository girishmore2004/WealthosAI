import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMemberDto } from "./dto/create-member.dto";
import { IncomeService } from "../income/income.service";
import { ExpensesService } from "../expenses/expenses.service";
import { InvestmentsService } from "../investments/investments.service";
import { LoansService } from "../loans/loans.service";
import { PropertyService } from "../property/property.service";
import { GoalsService } from "../goals/goals.service";
import { BusinessService } from "../business/business.service";
import { AlertsService } from "../alerts/alerts.service";
import { HouseholdMemberSummaryDTO, HouseholdSummaryDTO, SharedSubscriptionFlagDTO } from "@wealthos/types";

interface MemberFinancials {
  userId: string;
  name: string | null;
  role: string;
  monthlyIncome: number;
  monthlyExpenses: number;
  netWorth: number;
  investmentsValue: number;
  propertyValue: number;
  totalDebt: number;
  goalsTarget: number;
  goalsSaved: number;
  goalCount: number;
  businessProfitThisMonth: number;
  unreadAlertCount: number;
  subscriptionMerchants: string[];
}

@Injectable()
export class HouseholdService {
  constructor(
    private prisma: PrismaService,
    private incomeService: IncomeService,
    private expensesService: ExpensesService,
    private investmentsService: InvestmentsService,
    private loansService: LoansService,
    private propertyService: PropertyService,
    private goalsService: GoalsService,
    private businessService: BusinessService,
    private alertsService: AlertsService,
  ) {}

  async getOrCreateHouseholdForUser(userId: string) {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");

    if (user.householdId) {
      return this.prisma.client.household.findUnique({
        where: { id: user.householdId },
        include: { members: true, dependents: true },
      });
    }

    const household = await this.prisma.client.household.create({
      data: { name: `${user.name ?? "My"} Household`, members: { connect: { id: userId } } },
      include: { members: true, dependents: true },
    });
    return household;
  }

  async addDependent(userId: string, dto: CreateMemberDto) {
    const household = await this.getOrCreateHouseholdForUser(userId);
    return this.prisma.client.dependent.create({
      data: {
        householdId: household!.id,
        name: dto.name,
        relation: dto.relation,
        dateOfBirth: dto.dateOfBirth ? new Date(dto.dateOfBirth) : undefined,
      },
    });
  }

  async removeDependent(userId: string, dependentId: string) {
    const household = await this.getOrCreateHouseholdForUser(userId);
    return this.prisma.client.dependent.deleteMany({
      where: { id: dependentId, householdId: household!.id },
    });
  }

  // Gathers one member's own financials exactly once per call — this, plus the caller
  // never iterating the same userId twice (member lists come straight from the
  // Household.members relation, which has no duplicates by construction), is the whole
  // "no double counting" guarantee: every rupee in the aggregate traces back to exactly
  // one Income/Expense/Investment/Loan/Property/Goal/Business row, owned by exactly one
  // user. This schema has no joint-ownership concept yet (Property/Loan/etc. all have a
  // single userId) — true shared-asset splitting is a future schema change, not
  // something this aggregation can safely infer.
  private async gatherMemberFinancials(member: { id: string; name: string | null; role: string }): Promise<MemberFinancials> {
    const currentMonth = new Date().toISOString().slice(0, 7);
    const [
      monthlyIncome,
      monthExpenses,
      investmentsValue,
      propertyValue,
      totalDebt,
      goals,
      businesses,
      unreadAlerts,
      subscriptions,
    ] = await Promise.all([
      this.incomeService.monthlyForecast(member.id),
      this.expensesService.list(member.id, currentMonth),
      this.investmentsService.totalCurrentValue(member.id),
      this.propertyService.totalCurrentValue(member.id),
      this.loansService.totalOutstanding(member.id),
      this.goalsService.list(member.id),
      this.businessService.listBusinesses(member.id),
      this.alertsService.list(member.id, true),
      this.expensesService.detectSubscriptions(member.id),
    ]);

    const monthlyExpenses = monthExpenses.reduce((sum, e) => sum + Number(e.amount), 0);
    const allIncomes = await this.incomeService.list(member.id);
    const allExpenses = await this.expensesService.list(member.id);
    const cash = allIncomes.reduce((s, i) => s + Number(i.amount), 0) - allExpenses.reduce((s, e) => s + Number(e.amount), 0);
    const netWorth = cash + investmentsValue + propertyValue - totalDebt;

    const goalsTarget = goals.reduce((s, g) => s + Number(g.targetAmount), 0);
    const goalsSaved = goals.reduce((s, g) => s + Number(g.currentAmount) + Number(g.linkedInvestmentValue), 0);

    const businessProfits = await Promise.all(
      businesses.map((b) => this.businessService.monthlySummary(member.id, b.id, currentMonth)),
    );
    const businessProfitThisMonth = businessProfits.reduce((s, p) => s + Number(p.profit), 0);

    return {
      userId: member.id,
      name: member.name,
      role: member.role,
      monthlyIncome,
      monthlyExpenses,
      netWorth,
      investmentsValue,
      propertyValue,
      totalDebt,
      goalsTarget,
      goalsSaved,
      goalCount: goals.length,
      businessProfitThisMonth,
      unreadAlertCount: unreadAlerts.length,
      subscriptionMerchants: subscriptions.map((s) => s.merchant),
    };
  }

  async getHouseholdSummary(requestingUserId: string): Promise<HouseholdSummaryDTO> {
    const requestingUser = await this.prisma.client.user.findUnique({ where: { id: requestingUserId } });
    if (!requestingUser) throw new NotFoundException("User not found");

    const household = await this.getOrCreateHouseholdForUser(requestingUserId);
    const members = household!.members;

    const financials = await Promise.all(members.map((m) => this.gatherMemberFinancials(m)));

    // Flag merchants that recur for 2+ different members — see gatherMemberFinancials'
    // comment above for why these are surfaced rather than deduped or double-summed.
    const merchantToMembers = new Map<string, (string | null)[]>();
    for (const f of financials) {
      for (const merchant of f.subscriptionMerchants) {
        const key = merchant.toLowerCase();
        const list = merchantToMembers.get(key) ?? [];
        list.push(f.name);
        merchantToMembers.set(key, list);
      }
    }
    const possibleSharedSubscriptions: SharedSubscriptionFlagDTO[] = Array.from(merchantToMembers.entries())
      .filter(([, names]) => names.length >= 2)
      .map(([merchant, memberNames]) => ({
        merchant,
        // Names are only meaningful detail for an OWNER — a MEMBER viewer gets to know
        // "this looks shared" without learning exactly who else has it, which would
        // otherwise leak another member's private line-item data through the back door.
        memberNames: requestingUser.role === "OWNER" ? memberNames : [],
      }));

    const sum = (key: keyof MemberFinancials) => financials.reduce((s, f) => s + (f[key] as number), 0);

    const summary: HouseholdSummaryDTO = {
      householdId: household!.id,
      householdName: household!.name,
      memberCount: members.length,
      totalMonthlyIncome: sum("monthlyIncome").toFixed(2),
      totalMonthlyExpenses: sum("monthlyExpenses").toFixed(2),
      totalNetWorth: sum("netWorth").toFixed(2),
      totalInvestments: sum("investmentsValue").toFixed(2),
      totalDebt: sum("totalDebt").toFixed(2),
      totalPropertyValue: sum("propertyValue").toFixed(2),
      totalGoalsTarget: sum("goalsTarget").toFixed(2),
      totalGoalsSaved: sum("goalsSaved").toFixed(2),
      totalBusinessProfitThisMonth: sum("businessProfitThisMonth").toFixed(2),
      totalUnreadAlerts: sum("unreadAlertCount"),
      possibleSharedSubscriptions,
      viewerRole: requestingUser.role,
      members:
        requestingUser.role === "OWNER"
          ? financials.map((f): HouseholdMemberSummaryDTO => ({
              userId: f.userId,
              name: f.name,
              role: f.role as HouseholdMemberSummaryDTO["role"],
              monthlyIncome: f.monthlyIncome.toFixed(2),
              monthlyExpenses: f.monthlyExpenses.toFixed(2),
              netWorth: f.netWorth.toFixed(2),
              investmentsValue: f.investmentsValue.toFixed(2),
              propertyValue: f.propertyValue.toFixed(2),
              totalDebt: f.totalDebt.toFixed(2),
              goalCount: f.goalCount,
              unreadAlertCount: f.unreadAlertCount,
            }))
          : null,
    };

    return summary;
  }
}
