import { Injectable } from "@nestjs/common";
import { ExpensesService } from "../../../expenses/expenses.service";
import { IncomeService } from "../../../income/income.service";

export interface MonthlyPoint {
  month: string; // YYYY-MM
  totalExpenses: number;
  totalIncome: number;
  netCashflow: number;
  savingsRate: number; // netCashflow / totalIncome, 0 when totalIncome is 0
}

export interface CategoryExpensePoint {
  categoryId: string;
  categoryName: string;
  month: string;
  total: number;
}

export interface ExpenseTransactionPoint {
  id: string;
  categoryId: string;
  categoryName: string;
  amount: number;
  spentAt: Date;
}

const TRAILING_MONTHS_DEFAULT = 12;

@Injectable()
export class FeatureExtractionService {
  constructor(
    private expenses: ExpensesService,
    private income: IncomeService,
  ) {}

  /** All expense transactions with their category name attached, for anomaly
   * detection at the individual-transaction level. */
  async transactionPoints(userId: string): Promise<ExpenseTransactionPoint[]> {
    const expenses = await this.expenses.list(userId);
    return expenses.map((e: { id: string; categoryId: string; category: { name: string }; amount: unknown; spentAt: Date }) => ({
      id: e.id,
      categoryId: e.categoryId,
      categoryName: e.category.name,
      amount: Number(e.amount),
      spentAt: e.spentAt,
    }));
  }

  /** Monthly-aggregated income/expense/cashflow series, most-recent-last, for
   * regression/drift/segmentation models — all of which reason about a trend over
   * time, not a single snapshot. */
  async monthlySeries(userId: string, trailingMonths: number = TRAILING_MONTHS_DEFAULT): Promise<MonthlyPoint[]> {
    const [expenses, incomes] = await Promise.all([this.expenses.list(userId), this.income.list(userId)]);

    const months = this.trailingMonthKeys(trailingMonths);
    const expenseByMonth = new Map<string, number>();
    const incomeByMonth = new Map<string, number>();

    for (const e of expenses as { amount: unknown; spentAt: Date }[]) {
      const key = monthKey(e.spentAt);
      expenseByMonth.set(key, (expenseByMonth.get(key) ?? 0) + Number(e.amount));
    }
    for (const i of incomes as { amount: unknown; receivedAt: Date }[]) {
      const key = monthKey(i.receivedAt);
      incomeByMonth.set(key, (incomeByMonth.get(key) ?? 0) + Number(i.amount));
    }

    return months.map((month) => {
      const totalExpenses = expenseByMonth.get(month) ?? 0;
      const totalIncome = incomeByMonth.get(month) ?? 0;
      const netCashflow = totalIncome - totalExpenses;
      return {
        month,
        totalExpenses,
        totalIncome,
        netCashflow,
        savingsRate: totalIncome === 0 ? 0 : netCashflow / totalIncome,
      };
    });
  }

  /** Per-category monthly totals, for category-level anomaly baselines (this
   * category's own history, not the household total). */
  async categoryMonthlySeries(userId: string, trailingMonths: number = TRAILING_MONTHS_DEFAULT): Promise<CategoryExpensePoint[]> {
    const expenses = await this.expenses.list(userId);
    const months = new Set(this.trailingMonthKeys(trailingMonths));

    const totals = new Map<string, CategoryExpensePoint>();
    for (const e of expenses as { categoryId: string; category: { name: string }; amount: unknown; spentAt: Date }[]) {
      const month = monthKey(e.spentAt);
      if (!months.has(month)) continue;
      const key = `${e.categoryId}:${month}`;
      const existing = totals.get(key);
      if (existing) {
        existing.total += Number(e.amount);
      } else {
        totals.set(key, { categoryId: e.categoryId, categoryName: e.category.name, month, total: Number(e.amount) });
      }
    }
    return [...totals.values()];
  }

  private trailingMonthKeys(count: number): string[] {
    const months: string[] = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push(monthKey(d));
    }
    return months;
  }
}

function monthKey(date: Date): string {
  return date.toISOString().slice(0, 7);
}
