// Shared category-grouping utility for the Reports feature. Consolidates the Map-based
// groupby pattern that was previously duplicated inline in both
// ReportsService.monthlyReport() and ReportsService.yearlyReport() into one tested
// implementation. (ExpensesService.categoryBreakdown() has its own separate copy of this
// pattern for a different feature and is intentionally left untouched here.)

export interface CategoryAmountLike {
  category: { name: string };
  amount: unknown; // Prisma.Decimal | number | string — always passed through Number()
}

export interface CategoryBreakdownRow {
  category: string;
  amount: string;
  percentOfTotal: number;
}

export function groupExpensesByCategory<T extends CategoryAmountLike>(
  expenses: T[],
  totalExpenses: number,
): CategoryBreakdownRow[] {
  const byCategory = new Map<string, number>();

  for (const e of expenses) {
    const amount = Number(e.amount);
    byCategory.set(e.category.name, (byCategory.get(e.category.name) ?? 0) + amount);
  }

  return Array.from(byCategory.entries())
    .map(([category, amount]) => ({
      category,
      amount: amount.toFixed(2),
      percentOfTotal: totalExpenses > 0 ? Number(((amount / totalExpenses) * 100).toFixed(1)) : 0,
    }))
    .sort((a, b) => Number(b.amount) - Number(a.amount));
}
