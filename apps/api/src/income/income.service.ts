import { Injectable, ForbiddenException, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { CreateIncomeDto } from "./dto/create-income.dto";
import { UpdateIncomeDto } from "./dto/update-income.dto";

@Injectable()
export class IncomeService {
  constructor(private prisma: PrismaService) {}

  list(userId: string) {
    return this.prisma.client.income.findMany({
      where: { userId },
      orderBy: { receivedAt: "desc" },
    });
  }

  async create(userId: string, dto: CreateIncomeDto) {
    return this.prisma.client.income.create({
      data: { ...dto, userId, receivedAt: new Date(dto.receivedAt) },
    });
  }

  async update(userId: string, id: string, dto: UpdateIncomeDto) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.income.update({
      where: { id },
      data: { ...dto, receivedAt: dto.receivedAt ? new Date(dto.receivedAt) : undefined },
    });
  }

  async remove(userId: string, id: string) {
    await this.assertOwnership(userId, id);
    return this.prisma.client.income.delete({ where: { id } });
  }

  // Simple recurrence-aware forecast: projects recurring income into the current month.
  // (Full multi-month forecasting engine is out of scope for this MVP slice.)
  async monthlyForecast(userId: string): Promise<number> {
    const incomes = await this.list(userId);
    const multiplier: Record<string, number> = {
      ONE_TIME: 0,
      WEEKLY: 4.33,
      MONTHLY: 1,
      QUARTERLY: 1 / 3,
      YEARLY: 1 / 12,
    };
    return incomes.reduce((sum, inc) => sum + Number(inc.amount) * (multiplier[inc.recurrence] ?? 0), 0);
  }

  private async assertOwnership(userId: string, incomeId: string) {
    const income = await this.prisma.client.income.findUnique({ where: { id: incomeId } });
    if (!income) throw new NotFoundException("Income not found");
    if (income.userId !== userId) throw new ForbiddenException();
  }
}
