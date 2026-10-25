import type { GoalType } from "@wealthos/types";

// Every goal type the API accepts, in the order they are offered. Adding a type to the GoalType enum on the
// server needs no other frontend change: Money → Goals takes its labels and rules from the API, and this list
// only feeds the "new goal" pickers.
export const GOAL_TYPES: GoalType[] = [
  "EMERGENCY_FUND",
  "HOUSE",
  "LAND",
  "CAR",
  "MARRIAGE",
  "CHILD_EDUCATION",
  "RETIREMENT",
  "EARLY_RETIREMENT",
  "BUSINESS_EXPANSION",
  "VACATION",
  "HEALTHCARE_RESERVE",
  "PASSIVE_INCOME",
  "FAMILY_SUPPORT",
  "OTHER",
];

export const goalTypeLabel = (type: string): string => type.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Where to manage a goal's money. `emergency` resolves to the user's emergency fund. */
export const goalHref = (goalId: string | "emergency") => `/money/goals?goal=${goalId}`;
