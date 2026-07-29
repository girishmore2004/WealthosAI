import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomBytes } from "crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CreateMemberDto } from "./dto/create-member.dto";
import { CreateInviteDto } from "./dto/create-invite.dto";
import { RespondToInviteDto } from "./dto/respond-to-invite.dto";
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

const INVITE_TTL_DAYS = 7;
const INVITE_TOKEN_BYTES = 32; // matches the entropy already used for session tokens

function hashInviteToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
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

  // ---------------------------------------------------------------------------------
  // INVITE / ACCEPT / DECLINE / REVOKE / LEAVE (new) — closes the audit-flagged gap:
  // "No invite/join flow was found... worth checking if adding members needs a proper
  // invitation flow rather than just being pre-seeded." There genuinely was none —
  // every user's household was either auto-created solo (above) or presumably seeded
  // directly in the database; nothing in this file let one existing user actually bring
  // another into their household.
  //
  // DESIGN, deliberately scoped to stay within this feature's own files:
  //  - No email is sent by this app. POST /household/invites returns the raw token
  //    (once) for the OWNER to share via whatever channel they choose (text, WhatsApp,
  //    a copied link) — avoids needing to reuse Auth's OTP-shaped delivery adapter
  //    (built for a 6-digit code, not an arbitrary invite link) or build new email
  //    infrastructure, either of which would be out of scope for a Household-only
  //    change. The invited person still authenticates entirely through the existing,
  //    unmodified OTP login flow — this feature never touches auth itself.
  //  - Only the token's HASH is ever persisted (createHash/sha256), matching the exact
  //    discipline already used for OtpCode.codeHash and Session.tokenHash elsewhere in
  //    this schema — the raw token is returned exactly once, at creation time.
  //  - Accept is matched against the ACCEPTING user's own account email (case-
  //    insensitive), not just a valid token — so a leaked/guessed token alone can't add
  //    an arbitrary account to someone else's household; the account being added must
  //    actually be the invited email address.
  //  - Only an OWNER can create or revoke invites for their household — a MEMBER
  //    cannot invite arbitrary people into a household structure they don't control.

  async createInvite(inviterUserId: string, dto: CreateInviteDto) {
    const inviter = await this.prisma.client.user.findUnique({ where: { id: inviterUserId } });
    if (!inviter) throw new NotFoundException("User not found");
    if (inviter.role !== "OWNER") {
      throw new ForbiddenException("Only the household owner can send invites");
    }

    const household = await this.getOrCreateHouseholdForUser(inviterUserId);

    const existingPending = await this.prisma.client.householdInvite.findFirst({
      where: { householdId: household!.id, email: dto.email, status: "PENDING" },
    });
    if (existingPending) {
      throw new BadRequestException("There's already a pending invite for this email");
    }

    const rawToken = randomBytes(INVITE_TOKEN_BYTES).toString("base64url");
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

    const invite = await this.prisma.client.householdInvite.create({
      data: {
        householdId: household!.id,
        invitedById: inviterUserId,
        email: dto.email,
        tokenHash: hashInviteToken(rawToken),
        expiresAt,
      },
    });

    // rawToken is returned ONLY here, at creation time — it is never persisted and
    // never retrievable again after this response (matching how a session's rawToken
    // is handled in AuthController).
    return { invite, token: rawToken };
  }

  async listInvites(userId: string) {
    const requester = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!requester) throw new NotFoundException("User not found");
    if (requester.role !== "OWNER") {
      throw new ForbiddenException("Only the household owner can view invites");
    }

    const household = await this.getOrCreateHouseholdForUser(userId);
    return this.prisma.client.householdInvite.findMany({
      where: { householdId: household!.id },
      orderBy: { createdAt: "desc" },
    });
  }

  async revokeInvite(userId: string, inviteId: string) {
    const requester = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!requester) throw new NotFoundException("User not found");
    if (requester.role !== "OWNER") {
      throw new ForbiddenException("Only the household owner can revoke invites");
    }

    const household = await this.getOrCreateHouseholdForUser(userId);
    const result = await this.prisma.client.householdInvite.updateMany({
      where: { id: inviteId, householdId: household!.id, status: "PENDING" },
      data: { status: "REVOKED", respondedAt: new Date() },
    });

    if (result.count === 0) {
      throw new NotFoundException("Pending invite not found");
    }
    return { id: inviteId };
  }

  async acceptInvite(userId: string, dto: RespondToInviteDto) {
    const { invite, accepter } = await this.resolvePendingInviteForUser(userId, dto.token);

    // Refuse to silently pull someone out of a household they're not the sole member
    // of — that would orphan whoever they leave behind without their explicit action.
    // A solo household (just the accepter themselves, the common case for a fresh
    // account) is safe to leave automatically; anything larger requires them to
    // explicitly leave first (see leaveHousehold() below) so the decision is
    // deliberate, not a side effect of accepting an unrelated invite.
    if (accepter.householdId) {
      const currentHousehold = await this.prisma.client.household.findUnique({
        where: { id: accepter.householdId },
        include: { members: true },
      });
      if (currentHousehold && currentHousehold.members.length > 1) {
        throw new BadRequestException(
          "You're part of a household with other members — leave it first before accepting a different invite",
        );
      }
    }

    await this.prisma.client.$transaction([
      this.prisma.client.user.update({
        where: { id: userId },
        data: { householdId: invite.householdId, role: "MEMBER" },
      }),
      this.prisma.client.householdInvite.update({
        where: { id: invite.id },
        data: { status: "ACCEPTED", respondedAt: new Date() },
      }),
    ]);

    return this.getOrCreateHouseholdForUser(userId);
  }

  async declineInvite(userId: string, dto: RespondToInviteDto) {
    const { invite } = await this.resolvePendingInviteForUser(userId, dto.token);

    await this.prisma.client.householdInvite.update({
      where: { id: invite.id },
      data: { status: "DECLINED", respondedAt: new Date() },
    });

    return { id: invite.id };
  }

  // Shared lookup/validation for accept and decline: resolves the token to a PENDING,
  // unexpired invite addressed to the CALLING user's own account email (case-
  // insensitive) — the token alone is not sufficient, closing the "leaked/guessed
  // token adds the wrong account" gap described above. Auto-marks a found-but-expired
  // invite as EXPIRED (a lazy sweep — no separate cron/scheduled job needed) rather
  // than leaving it PENDING forever.
  private async resolvePendingInviteForUser(userId: string, rawToken: string) {
    const accepter = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!accepter) throw new NotFoundException("User not found");

    const invite = await this.prisma.client.householdInvite.findUnique({
      where: { tokenHash: hashInviteToken(rawToken) },
    });

    if (!invite || invite.email.toLowerCase() !== accepter.email.toLowerCase()) {
      // Deliberately the same generic error whether the token doesn't exist at all or
      // exists but is addressed to a different email — no oracle for "this token is
      // real but not yours."
      throw new NotFoundException("Invite not found");
    }

    if (invite.status !== "PENDING") {
      throw new BadRequestException(`This invite has already been ${invite.status.toLowerCase()}`);
    }

    if (invite.expiresAt < new Date()) {
      await this.prisma.client.householdInvite.update({
        where: { id: invite.id },
        data: { status: "EXPIRED" },
      });
      throw new BadRequestException("This invite has expired");
    }

    return { invite, accepter };
  }

  // A MEMBER can always leave. An OWNER can only leave a household that's already just
  // themselves (nothing to actually leave) — leaving a multi-member household would
  // orphan it with no owner, and this feature deliberately does not implement
  // ownership transfer (a bigger decision, out of scope here). Either way, the user
  // ends up with a fresh solo household of their own immediately (never left with
  // householdId: null), reusing the exact same creation path getOrCreateHouseholdForUser
  // already uses.
  async leaveHousehold(userId: string) {
    const user = await this.prisma.client.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException("User not found");
    if (!user.householdId) {
      return this.getOrCreateHouseholdForUser(userId); // nothing to leave; already solo
    }

    const currentHousehold = await this.prisma.client.household.findUnique({
      where: { id: user.householdId },
      include: { members: true },
    });

    if (user.role === "OWNER" && currentHousehold && currentHousehold.members.length > 1) {
      throw new BadRequestException(
        "As the owner of a household with other members, you can't leave directly — remove other members first",
      );
    }

    await this.prisma.client.user.update({
      where: { id: userId },
      data: { householdId: null, role: "OWNER" },
    });

    return this.getOrCreateHouseholdForUser(userId);
  }

  // ---------------------------------------------------------------------------------
  // Everything below is UNCHANGED from before this update.

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
