// Pure data-health detectors. Each takes plain data and returns issues; none touch the
// database and none modify or delete anything — they only FLAG records for human review.

export type DataHealthCode =
  | "DUPLICATE_SALARY"
  | "DUPLICATE_EXPENSE"
  | "INVESTMENT_AS_EXPENSE"
  | "EMERGENCY_AS_EXPENSE"
  | "DUPLICATE_INSURANCE_PREMIUM"
  | "STALE_INVESTMENT_VALUATION"
  | "MISSING_INVESTMENT_VALUATION"
  | "MISSING_SOURCE_REFERENCE"
  | "NEGATIVE_AVAILABLE_CASH"
  | "DUPLICATE_RECURRING_EVENT"
  | "INCONSISTENT_COST_BASIS"
  | "POSSIBLE_BANK_DUPLICATE"
  | "UNLINKED_DOCUMENT"
  | "DOCUMENT_DISCREPANCY";

export interface DataHealthIssue {
  code: DataHealthCode;
  severity: "WARNING" | "INFO";
  message: string;
  count: number;
  amount?: string;
  entityIds: string[]; // record ids the user should review (capped)
}

const ID_CAP = 20;
const issue = (i: Omit<DataHealthIssue, "entityIds"> & { entityIds: string[] }): DataHealthIssue => ({
  ...i,
  entityIds: i.entityIds.slice(0, ID_CAP),
});
const sum = (xs: Array<string | number>): string => xs.reduce<number>((a, b) => a + Number(b), 0).toFixed(2);
const day = (d: Date) => d.toISOString().slice(0, 10);
const month = (d: Date) => d.toISOString().slice(0, 7);
const DAY_MS = 86_400_000;

export interface IncomeRow {
  id: string;
  source: string;
  amount: string;
  receivedAt: Date;
  generatedFromRecurringId: string | null;
}
export interface ExpenseRow {
  id: string;
  amount: string;
  spentAt: Date;
  merchant: string | null;
  categoryName: string;
  categoryType: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceReference: string | null;
  migrated: boolean; // a cashflow / reserve entry already points at it
}
export interface ContributionRow {
  id: string;
  investmentId: string;
  amount: string;
  occurredAt: Date;
}
export interface PolicyRow {
  id: string;
  premiumAmount: string;
}
export interface InvestmentRow {
  id: string;
  name: string;
  costBasis: string;
  latestValuationAt: Date | null;
  netCostFromCashflows: string | null; // null when the investment has no cashflows yet
}

export function detectDuplicateSalary(incomes: IncomeRow[]): DataHealthIssue[] {
  const groups = new Map<string, IncomeRow[]>();
  for (const i of incomes) {
    if (i.source !== "SALARY") continue;
    const k = `${month(i.receivedAt)}|${Number(i.amount)}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  if (dups.length === 0) return [];
  const rows = dups.flat();
  return [
    issue({
      code: "DUPLICATE_SALARY",
      severity: "WARNING",
      message: "More than one salary entry of the same amount exists in the same month. Income may be overstated.",
      count: dups.length,
      amount: sum(dups.map((g) => g[1].amount)), // the surplus copies
      entityIds: rows.map((r) => r.id),
    }),
  ];
}

export function detectDuplicateRecurringEvents(incomes: IncomeRow[]): DataHealthIssue[] {
  const groups = new Map<string, IncomeRow[]>();
  for (const i of incomes) {
    if (!i.generatedFromRecurringId) continue;
    const k = `${i.generatedFromRecurringId}|${month(i.receivedAt)}`;
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const dups = [...groups.values()].filter((g) => g.length > 1);
  return dups.length === 0
    ? []
    : [
        issue({
          code: "DUPLICATE_RECURRING_EVENT",
          severity: "WARNING",
          message: "A recurring income template produced more than one transaction in a single period.",
          count: dups.length,
          entityIds: dups.flat().map((r) => r.id),
        }),
      ];
}

export function detectExpenseDuplicates(expenses: ExpenseRow[]): DataHealthIssue[] {
  const spend = expenses.filter((e) => e.categoryType !== "SAVINGS");
  const out: DataHealthIssue[] = [];

  const exact = new Map<string, ExpenseRow[]>();
  for (const e of spend) {
    if (!e.merchant) continue; // without a merchant "same amount" is far too weak a signal
    const k = `${e.merchant.toLowerCase()}|${Number(e.amount)}|${day(e.spentAt)}`;
    exact.set(k, [...(exact.get(k) ?? []), e]);
  }
  const exactDups = [...exact.values()].filter((g) => g.length > 1);
  if (exactDups.length > 0) {
    out.push(
      issue({
        code: "DUPLICATE_EXPENSE",
        severity: "WARNING",
        message: "Expenses with the same merchant, amount and date appear more than once. They may be double-entered.",
        count: exactDups.length,
        amount: sum(exactDups.map((g) => g[0].amount)),
        entityIds: exactDups.flat().map((r) => r.id),
      }),
    );
  }

  // Near-duplicates: same merchant + amount on DIFFERENT days within 2 days — typical of a
  // manual entry plus a later bank import of the same payment.
  const nearIds = new Set<string>();
  const byKey = new Map<string, ExpenseRow[]>();
  for (const e of spend) {
    if (!e.merchant) continue;
    const k = `${e.merchant.toLowerCase()}|${Number(e.amount)}`;
    byKey.set(k, [...(byKey.get(k) ?? []), e]);
  }
  for (const g of byKey.values()) {
    const s = [...g].sort((a, b) => a.spentAt.getTime() - b.spentAt.getTime());
    for (let i = 1; i < s.length; i++) {
      const gap = s[i].spentAt.getTime() - s[i - 1].spentAt.getTime();
      if (gap > 0 && gap <= 2 * DAY_MS) {
        nearIds.add(s[i - 1].id);
        nearIds.add(s[i].id);
      }
    }
  }
  if (nearIds.size > 0) {
    out.push(
      issue({
        code: "POSSIBLE_BANK_DUPLICATE",
        severity: "INFO",
        message: "Similar expenses (same merchant and amount) occur within 2 days of each other; one may be a bank-import duplicate.",
        count: Math.ceil(nearIds.size / 2),
        entityIds: [...nearIds],
      }),
    );
  }
  return out;
}

/** Legacy SAVINGS-category expenses that no contribution/reserve entry has absorbed yet. */
export function detectLegacySavingsExpenses(expenses: ExpenseRow[], contributions: ContributionRow[]): DataHealthIssue[] {
  const open = expenses.filter((e) => e.categoryType === "SAVINGS" && !e.migrated);
  const emergency = open.filter((e) => /emergency/i.test(e.categoryName));
  const invest = open.filter((e) => !/emergency/i.test(e.categoryName));
  const out: DataHealthIssue[] = [];

  if (invest.length > 0) {
    // The headline case from the spec: ₹10,000 recorded BOTH as an expense and a contribution.
    const doubled = invest.filter((e) =>
      contributions.some((c) => month(c.occurredAt) === month(e.spentAt) && Number(c.amount) === Number(e.amount)),
    );
    out.push(
      issue({
        code: "INVESTMENT_AS_EXPENSE",
        severity: "WARNING",
        message:
          doubled.length > 0
            ? `Possible duplicate SIP: ${doubled.length} investment expense(s) match an existing contribution for the same month and amount, so the investment total may be overstated until reconciled.`
            : "Investment/SIP entries are recorded as expenses. They are excluded from expense totals but not yet counted as contributions until migrated.",
        count: invest.length,
        amount: sum(invest.map((e) => e.amount)),
        entityIds: invest.map((e) => e.id),
      }),
    );
  }
  if (emergency.length > 0) {
    out.push(
      issue({
        code: "EMERGENCY_AS_EXPENSE",
        severity: "WARNING",
        message: "Emergency-fund allocations are recorded as expenses. They are excluded from expense totals but not yet counted in Emergency Cash until migrated.",
        count: emergency.length,
        amount: sum(emergency.map((e) => e.amount)),
        entityIds: emergency.map((e) => e.id),
      }),
    );
  }
  return out;
}

export function detectInsuranceIssues(expenses: ExpenseRow[], policies: PolicyRow[]): DataHealthIssue[] {
  const premiumLike = expenses.filter((e) => /insurance|premium/i.test(e.categoryName) && e.categoryType !== "SAVINGS");
  const unlinked = premiumLike.filter((e) => e.sourceType !== "INSURANCE_PREMIUM");
  const linked = premiumLike.filter((e) => e.sourceType === "INSURANCE_PREMIUM");
  const out: DataHealthIssue[] = [];

  if (unlinked.length > 0) {
    out.push(
      issue({
        code: "MISSING_SOURCE_REFERENCE",
        severity: "INFO",
        message: "Insurance expenses exist that are not linked to a policy.",
        count: unlinked.length,
        amount: sum(unlinked.map((e) => e.amount)),
        entityIds: unlinked.map((e) => e.id),
      }),
    );
  }

  // A manual, unlinked premium whose amount equals a policy premium that is ALREADY
  // recorded (linked) in the same month is almost certainly counted twice.
  const dupIds: string[] = [];
  for (const u of unlinked) {
    const policyAmounts = new Set(policies.map((p) => Number(p.premiumAmount)));
    if (!policyAmounts.has(Number(u.amount))) continue;
    const covered = linked.some((l) => month(l.spentAt) === month(u.spentAt) && Number(l.amount) === Number(u.amount));
    if (covered) dupIds.push(u.id);
  }
  if (dupIds.length > 0) {
    out.push(
      issue({
        code: "DUPLICATE_INSURANCE_PREMIUM",
        severity: "WARNING",
        message: "A manually entered premium matches a policy premium that is already recorded for the same month.",
        count: dupIds.length,
        entityIds: dupIds,
      }),
    );
  }
  return out;
}

export function detectInvestmentIssues(investments: InvestmentRow[], now: Date, staleDays = 120): DataHealthIssue[] {
  const out: DataHealthIssue[] = [];
  const missing = investments.filter((i) => i.latestValuationAt === null);
  const cutoff = now.getTime() - staleDays * DAY_MS;
  const stale = investments.filter((i) => i.latestValuationAt !== null && i.latestValuationAt.getTime() < cutoff);
  if (missing.length > 0) {
    out.push(
      issue({
        code: "MISSING_INVESTMENT_VALUATION",
        severity: "INFO",
        message: "Some investments have no dated valuation; their legacy current value is being used.",
        count: missing.length,
        entityIds: missing.map((i) => i.id),
      }),
    );
  }
  if (stale.length > 0) {
    out.push(
      issue({
        code: "STALE_INVESTMENT_VALUATION",
        severity: "WARNING",
        message: `Some investment valuations are older than ${staleDays} days, so portfolio value may be out of date.`,
        count: stale.length,
        entityIds: stale.map((i) => i.id),
      }),
    );
  }
  const inconsistent = investments.filter((i) => {
    if (i.netCostFromCashflows === null) return false;
    const a = Number(i.costBasis);
    const b = Number(i.netCostFromCashflows);
    const base = Math.max(Math.abs(a), Math.abs(b), 1);
    return Math.abs(a - b) / base > 0.01;
  });
  if (inconsistent.length > 0) {
    out.push(
      issue({
        code: "INCONSISTENT_COST_BASIS",
        severity: "WARNING",
        message: "The stored cost basis differs from the cost implied by recorded cashflows by more than 1%.",
        count: inconsistent.length,
        entityIds: inconsistent.map((i) => i.id),
      }),
    );
  }
  return out;
}

export function detectNegativeCash(availableCash: string): DataHealthIssue[] {
  return Number(availableCash) < 0
    ? [
        issue({
          code: "NEGATIVE_AVAILABLE_CASH",
          severity: "WARNING",
          message:
            "Available Cash is negative. Recorded outflows exceed recorded inflows, so income or an opening balance may be missing.",
          count: 1,
          amount: availableCash,
          entityIds: [],
        }),
      ]
    : [];
}

export interface DocumentRow {
  id: string;
  category: string;
  entityType: string | null;
}

// Categories that are inherently ABOUT a specific record (a policy, a loan, a holding ...).
// Receipts, bills and ID documents are legitimately standalone, so they are not flagged.
const NEEDS_ENTITY_LINK = new Set(["INSURANCE_POLICY", "LOAN_DOCUMENT", "PROPERTY_PAPER", "MF_STATEMENT", "TAX_RETURN"]);

export function detectUnlinkedDocuments(documents: DocumentRow[]): DataHealthIssue[] {
  const unlinked = documents.filter((d) => NEEDS_ENTITY_LINK.has(d.category) && d.entityType === null);
  return unlinked.length === 0
    ? []
    : [
        issue({
          code: "UNLINKED_DOCUMENT",
          severity: "INFO",
          message: "Some documents that belong to a policy, loan, property or investment are not linked to it, so they cannot be used to verify your records.",
          count: unlinked.length,
          entityIds: unlinked.map((d) => d.id),
        }),
      ];
}

export function detectDocumentDiscrepancies(open: Array<{ id: string }>): DataHealthIssue[] {
  return open.length === 0
    ? []
    : [
        issue({
          code: "DOCUMENT_DISCREPANCY",
          severity: "WARNING",
          message: "A linked document shows a different value from your records. Your records were not changed; review the difference.",
          count: open.length,
          entityIds: open.map((d) => d.id),
        }),
      ];
}
