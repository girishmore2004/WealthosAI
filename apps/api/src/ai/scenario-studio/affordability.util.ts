// Same monthly-surplus formula Phase 12's goal_conflict gatherer uses
// (income − expenses − existing EMIs) — kept here as its own small, dependency-free
// function rather than re-importing that gatherer, since this module needs it as a
// pure calculation over already-fetched numbers, not as a service with its own DB
// calls.
export function computeMonthlySurplus(monthlyIncome: number, monthlyExpenses: number, totalMonthlyEmi: number): number {
  return monthlyIncome - monthlyExpenses - totalMonthlyEmi;
}

/** Inverts the EMI formula to find the largest loan principal whose EMI doesn't
 * exceed `maxEmi` — used by HOUSE_PURCHASE's "constrained" variant to answer "what
 * property value can I actually afford" rather than just capping propertyValue
 * arbitrarily. Mirrors simulator.engine.ts's calculateEmi exactly (same formula,
 * solved for principal instead of EMI) so the two stay consistent with each other. */
export function maxAffordablePrincipal(maxEmi: number, annualRatePercent: number, tenureMonths: number): number {
  if (maxEmi <= 0 || tenureMonths <= 0) return 0;
  const monthlyRate = annualRatePercent / 12 / 100;
  if (monthlyRate === 0) return maxEmi * tenureMonths;
  const factor = Math.pow(1 + monthlyRate, tenureMonths);
  return (maxEmi * (factor - 1)) / (monthlyRate * factor);
}
