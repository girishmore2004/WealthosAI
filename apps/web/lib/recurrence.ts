import type { ExpenseDTO } from "@wealthos/types";

// The cadences a repeating expense can use (ONE_TIME is "not repeating", so it is not an option).
export const REPEAT_CADENCES = [
  { value: "WEEKLY", label: "Weekly" },
  { value: "BIWEEKLY", label: "Every 2 weeks" },
  { value: "MONTHLY", label: "Monthly" },
  { value: "QUARTERLY", label: "Quarterly" },
  { value: "YEARLY", label: "Yearly" },
] as const;

export const cadenceLabel = (v: string | null | undefined): string => REPEAT_CADENCES.find((c) => c.value === v)?.label ?? "";

// What part a row plays in a recurrence:
//   TEMPLATE   — the row the repeat was set up on (it is also the first real occurrence);
//   OCCURRENCE — a row the recurrence engine generated;
//   NONE       — an ordinary one-off expense.
export type RecurrenceRole = "TEMPLATE" | "OCCURRENCE" | "NONE";

export function recurrenceRole(e: Pick<ExpenseDTO, "generatedFromRecurringId" | "recurrence">): RecurrenceRole {
  if (e.generatedFromRecurringId) return "OCCURRENCE";
  if (e.recurrence && e.recurrence !== "ONE_TIME") return "TEMPLATE";
  return "NONE";
}
