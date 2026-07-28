import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateGoalDto } from "./dto/create-goal.dto";
import { UpdateGoalDto } from "./dto/update-goal.dto";
import { GoalDTO } from "@wealthos/types";

@Injectable()
export class GoalsService {
  constructor(private prisma: PrismaService) {}

  async list(userId: string): Promise<GoalDTO[]> {
    const goals = await this.prisma.client.goal.findMany({
      where: { userId },
      include: { investments: true },
      orderBy: { targetDate: "asc" },
    });
    return goals.map((g) => this.enrich(g));
  }

  async create(userId: string, dto: CreateGoalDto) {
    const goal = await this.prisma.client.goal.create({
      data: {
        ...dto,
        userId,
        targetDate: new Date(dto.targetDate),
      },
      include: { investments: true },
    });
    return this.enrich(goal);
  }

  // Ownership enforced atomically as part of the write (updateMany scoped by
  // {id, userId}) instead of a separate findUnique-then-check read beforehand — same
  // hardening already applied to every other money module this session: closes the
  // TOCTOU gap between "check ownership" and "perform the write," and collapses a
  // cross-user access attempt and a nonexistent id into the same 404 rather than
  // leaking which case occurred via a 403/404 split (previously ForbiddenException vs
  // NotFoundException).
  async update(userId: string, id: string, dto: UpdateGoalDto) {
    const result = await this.prisma.client.goal.updateMany({
      where: { id, userId },
      data: { ...dto, targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined },
    });

    if (result.count === 0) {
      throw new NotFoundException("Goal not found");
    }

    const goal = await this.prisma.client.goal.findUnique({ where: { id }, include: { investments: true } });
    return this.enrich(goal!);
  }

  // Same atomic-ownership approach, and a genuine round-trip reduction: one
  // deleteMany({ id, userId }) replaces the previous findUnique-then-delete pair.
  // Returns { id } rather than the deleted row — verified against apps/web's goals
  // page (api.goals.remove(id)'s response is never read; it always re-fetches the list
  // afterward) before making this change.
  async remove(userId: string, id: string) {
    const result = await this.prisma.client.goal.deleteMany({ where: { id, userId } });

    if (result.count === 0) {
      throw new NotFoundException("Goal not found");
    }

    return { id };
  }

  // Feasibility is intentionally a simple, explainable heuristic (contribution pace vs.
  // required pace) rather than a Monte Carlo simulation — the What-If Simulator module
  // is the right place for stochastic probability-of-success modeling. This comment,
  // and the underlying design choice, are unchanged from before this update.
  //
  // TWO changes from the original implementation, both additive/opt-in:
  //
  // 1. GROWTH-AWARE PROJECTION (new): the original calculation implicitly assumed a
  //    goal's linked investment value would sit completely flat (zero growth) between
  //    now and the target date when computing how much MORE needs to be contributed —
  //    a real simplification for any goal already holding money in growth assets. If
  //    the goal has assumedAnnualReturnPercent set, requiredMonthlyContribution and
  //    probabilityOfSuccess are now computed against a projection of the linked
  //    investment value compounded to the target date, not its flat current value.
  //    Unset (the default for every existing goal) reproduces the exact original
  //    output — verified by all 5 pre-existing tests passing unmodified.
  //    Deliberately NOT applied to progressPercent/totalSaved, which describe today's
  //    actual state, not a forecast — only the forward-looking figures change.
  //
  // 2. NAMING/CLARITY (audit-flagged): probabilityOfSuccess itself and its 3 exact
  //    enum values are UNCHANGED — Alerts, Coach, the Agentic Coach's data gatherer,
  //    and the frontend all match against these exact strings, so renaming it would be
  //    a breaking change across 4+ consumers for a naming concern alone. Instead, two
  //    new additive fields carry the honest signal: contributionPaceRatio (a real
  //    number: monthlyContribution / requiredMonthlyContribution) and
  //    isPaceHeuristic: true (an explicit, permanent, machine-readable disclosure that
  //    this was never a modeled probability). A future UI update can use these to
  //    render a precise number and/or a clarifying label without any further backend
  //    change.
  private enrich(
    goal: {
      id: string;
      userId: string;
      type: string;
      name: string;
      targetAmount: unknown;
      targetDate: Date;
      currentAmount: unknown;
      monthlyContribution: unknown;
      assumedAnnualReturnPercent: unknown;
      investments: { currentValue: unknown }[];
    },
  ): GoalDTO {
    const targetAmount = Number(goal.targetAmount);
    const currentAmount = Number(goal.currentAmount);
    const monthlyContribution = Number(goal.monthlyContribution);
    const linkedInvestmentValue = goal.investments.reduce((sum, i) => sum + Number(i.currentValue), 0);

    const totalSaved = currentAmount + linkedInvestmentValue;
    const monthsRemaining = Math.max(
      1,
      Math.ceil((goal.targetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24 * 30.44)),
    );
    // Today's actual shortfall — used only for the "already fully funded right now"
    // check below, and for progressPercent. Never growth-projected.
    const remaining = Math.max(0, targetAmount - totalSaved);
    const progressPercent = targetAmount > 0 ? Number(Math.min(100, (totalSaved / targetAmount) * 100).toFixed(1)) : 0;

    const assumedAnnualReturn = Number(goal.assumedAnnualReturnPercent ?? 0) / 100;
    const monthlyReturn = assumedAnnualReturn / 12;
    const projectedInvestmentValueAtTarget =
      Math.abs(monthlyReturn) < 0.0001
        ? linkedInvestmentValue
        : linkedInvestmentValue * Math.pow(1 + monthlyReturn, monthsRemaining);

    const remainingForRequiredCalc = Math.max(0, targetAmount - currentAmount - projectedInvestmentValueAtTarget);
    const requiredMonthlyContribution = Number((remainingForRequiredCalc / monthsRemaining).toFixed(2));

    let probabilityOfSuccess: GoalDTO["probabilityOfSuccess"] = "OFF_TRACK";
    if (remaining === 0 || monthlyContribution >= requiredMonthlyContribution * 0.95) {
      probabilityOfSuccess = "ON_TRACK";
    } else if (monthlyContribution >= requiredMonthlyContribution * 0.6) {
      probabilityOfSuccess = "AT_RISK";
    }

    // Uncapped by design — a genuinely honest ratio, not a bucketed label. 1 whenever
    // no further contribution is actually required (remainingForRequiredCalc already
    // 0), regardless of the goal's monthlyContribution value.
    const contributionPaceRatio =
      requiredMonthlyContribution > 0 ? Number((monthlyContribution / requiredMonthlyContribution).toFixed(3)) : 1;

    return {
      id: goal.id,
      userId: goal.userId,
      type: goal.type as GoalDTO["type"],
      name: goal.name,
      targetAmount: targetAmount.toFixed(2),
      targetDate: goal.targetDate.toISOString(),
      currentAmount: currentAmount.toFixed(2),
      monthlyContribution: monthlyContribution.toFixed(2),
      linkedInvestmentValue: linkedInvestmentValue.toFixed(2),
      requiredMonthlyContribution,
      progressPercent,
      probabilityOfSuccess,
      contributionPaceRatio,
      isPaceHeuristic: true,
      projectedInvestmentValueAtTarget: projectedInvestmentValueAtTarget.toFixed(2),
      assumedAnnualReturnPercent: (assumedAnnualReturn * 100).toFixed(2),
    };
  }
}
