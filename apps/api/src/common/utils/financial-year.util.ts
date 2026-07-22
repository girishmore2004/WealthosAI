// India's financial year runs April 1 – March 31, formatted as "YYYY-YY" (e.g. "2026-27").
// Was previously duplicated in tax.controller.ts and reports.service.ts — factored out
// here so there's exactly one definition to test and reuse (coach.service.ts uses it too).
export function currentFinancialYear(reference: Date = new Date()): string {
  const year = reference.getMonth() >= 3 ? reference.getFullYear() : reference.getFullYear() - 1;
  return `${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

export function financialYearRange(financialYear: string): { fyStart: Date; fyEnd: Date } {
  const [startYear] = financialYear.split("-").map(Number);
  return {
    fyStart: new Date(startYear, 3, 1), // April 1
    fyEnd: new Date(startYear + 1, 2, 31, 23, 59, 59), // March 31 next year
  };
}
