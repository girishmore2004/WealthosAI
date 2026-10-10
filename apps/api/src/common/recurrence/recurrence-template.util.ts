// PURE MODULE — no Prisma client, no I/O. The VALUES a recurring expense is generated with.
//
// Why this exists: a recurring expense's "template" is an ordinary expense row — the first real
// occurrence — and the generator used to copy that row's own fields into every later occurrence.
// That conflated two things: the historical record ("I paid ₹999 on 4 Sep") and the rule for the
// future ("charge ₹999 each month"). Editing the first row to fix a typo, or correcting one
// month's amount, silently changed what every FUTURE occurrence would be created with.
//
// The rule is now allowed to live separately in `Expense.recurrenceTemplate` (a JSON snapshot).
// When it is null — every existing row — the row's own fields ARE the rule, so nothing changes
// until someone edits a rule. When it is present, it wins field by field.

import { Prisma } from "@wealthos/db";

export type RulePaymentMethod = "UPI" | "CARD" | "CASH" | "BANK_TRANSFER" | "WALLET" | "OTHER";
export type RuleFlowType = "EXPENSE" | "OTHER_OUTFLOW";

export interface ExpenseRuleValues {
  categoryId: string;
  merchant: string | null;
  // The row's own Decimal/number when no snapshot overrides it; a fixed "1234.50" string when it does.
  amount: Prisma.Decimal.Value;
  paymentMethod: RulePaymentMethod;
  notes: string | null;
  flowType: RuleFlowType;
}

/** The subset of an Expense row the rule is derived from. */
export interface RuleSourceRow {
  categoryId: string;
  merchant: string | null;
  amount: Prisma.Decimal.Value;
  paymentMethod: string;
  notes: string | null;
  flowType?: string | null;
  recurrenceTemplate?: unknown;
}

export const RULE_FIELDS = ["categoryId", "merchant", "amount", "paymentMethod", "notes", "flowType"] as const;
export type RuleField = (typeof RULE_FIELDS)[number];

const PAYMENT_METHODS: RulePaymentMethod[] = ["UPI", "CARD", "CASH", "BANK_TRANSFER", "WALLET", "OTHER"];
const isPaymentMethod = (v: unknown): v is RulePaymentMethod => typeof v === "string" && (PAYMENT_METHODS as string[]).includes(v);
const isFlowType = (v: unknown): v is RuleFlowType => v === "EXPENSE" || v === "OTHER_OUTFLOW";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The row's own fields as rule values (what generation used before rules could be edited). */
export function ruleFromRow(row: RuleSourceRow): ExpenseRuleValues {
  return {
    categoryId: row.categoryId,
    merchant: row.merchant ?? null,
    amount: row.amount,
    paymentMethod: isPaymentMethod(row.paymentMethod) ? row.paymentMethod : "UPI",
    notes: row.notes ?? null,
    flowType: isFlowType(row.flowType) ? row.flowType : "EXPENSE",
  };
}

/**
 * The values the NEXT generated occurrence must use. The snapshot wins field by field; anything
 * missing or malformed in it falls back to the row's own value, so a damaged JSON blob can never
 * produce a broken occurrence (or stop generation).
 */
export function resolveExpenseRule(row: RuleSourceRow): ExpenseRuleValues {
  const base = ruleFromRow(row);
  const snap = row.recurrenceTemplate;
  if (!isObject(snap)) return base;

  const amount = snap.amount;
  const amountOk = (typeof amount === "string" || typeof amount === "number") && Number.isFinite(Number(amount)) && Number(amount) > 0;
  return {
    categoryId: typeof snap.categoryId === "string" && snap.categoryId ? snap.categoryId : base.categoryId,
    merchant: snap.merchant === null || typeof snap.merchant === "string" ? (snap.merchant as string | null) : base.merchant,
    amount: amountOk ? (amount as string | number) : base.amount,
    paymentMethod: isPaymentMethod(snap.paymentMethod) ? snap.paymentMethod : base.paymentMethod,
    notes: snap.notes === null || typeof snap.notes === "string" ? (snap.notes as string | null) : base.notes,
    flowType: isFlowType(snap.flowType) ? snap.flowType : base.flowType,
  };
}

/** Changes a caller may make to a rule (every field optional). */
export type RuleChanges = Partial<{
  categoryId: string;
  merchant: string | null;
  amount: number | string;
  paymentMethod: string;
  notes: string | null;
  flowType: string;
}>;

/** True when `changes` touches at least one field that feeds future occurrences. */
export const touchesRule = (changes: Record<string, unknown>): boolean => RULE_FIELDS.some((f) => changes[f] !== undefined);

/** The rule with `changes` applied on top — returned as a plain JSON-safe object (amount as a fixed string). */
export function applyRuleChanges(base: ExpenseRuleValues, changes: RuleChanges): Prisma.InputJsonObject {
  const merged = {
    categoryId: changes.categoryId ?? base.categoryId,
    merchant: changes.merchant !== undefined ? changes.merchant : base.merchant,
    amount: new Prisma.Decimal(changes.amount !== undefined ? changes.amount : base.amount).toFixed(2),
    paymentMethod: isPaymentMethod(changes.paymentMethod) ? changes.paymentMethod : base.paymentMethod,
    notes: changes.notes !== undefined ? changes.notes : base.notes,
    flowType: isFlowType(changes.flowType) ? changes.flowType : base.flowType,
  };
  return merged;
}
