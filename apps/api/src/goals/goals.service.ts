import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
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

  async update(userId: string, id: string, dto: UpdateGoalDto) {
    await this.assertOwnership(userId, id);
    const goal = await this.prisma.client.goal.update({
      where: { id },
      data: { ...dto, targetDate: dto.targetDate ? new Date(dto.targetDate) : undefined },
      include: { investments: true },
    });
    return this.enrich(goal);
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.goal.delete({ where: { id } });
  }

  // Feasibility is intentionally a simple, explainable heuristic (contribution pace vs.
  // required pace) rather than a Monte Carlo simulation — the What-If Simulator module
  // (later phase) is the right place for stochastic probability-of-success modeling.
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
    const remaining = Math.max(0, targetAmount - totalSaved);
    const requiredMonthlyContribution = Number((remaining / monthsRemaining).toFixed(2));
    const progressPercent = targetAmount > 0 ? Number(Math.min(100, (totalSaved / targetAmount) * 100).toFixed(1)) : 0;

    let probabilityOfSuccess: GoalDTO["probabilityOfSuccess"] = "OFF_TRACK";
    if (remaining === 0 || monthlyContribution >= requiredMonthlyContribution * 0.95) {
      probabilityOfSuccess = "ON_TRACK";
    } else if (monthlyContribution >= requiredMonthlyContribution * 0.6) {
      probabilityOfSuccess = "AT_RISK";
    }

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
    };
  }

  private async assertOwnership(userId: string, goalId: string) {
    const goal = await this.prisma.client.goal.findUnique({ where: { id: goalId } });
    if (!goal) throw new NotFoundException("Goal not found");
    if (goal.userId !== userId) throw new ForbiddenException();
  }
}
