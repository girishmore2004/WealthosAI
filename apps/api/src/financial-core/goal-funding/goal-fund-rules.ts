// PURE — the one table that says what each kind of goal supports and which words to use for it.
// Money → Goals is driven entirely by this: a goal of ANY type (including ones added to the GoalType enum
// later) gets the full funding experience, and falls back to the generic rules if it has no row here.
// Nothing about a particular goal is registered in the frontend.

import type { GoalFundBacking, GoalFundRulesDTO, GoalSpendMode } from "@wealthos/types";

type Row = Omit<GoalFundRulesDTO, "supportsCoverage" | "supportsMonthsTarget">;

const SOURCES = ["Monthly contribution", "Bonus", "Extra savings", "Salary allocation"];

// SPEND MODES
//   EXPENSE        the money was consumed: one genuine Expense is recorded (counted once).
//   OTHER_OUTFLOW  the money left cash but bought something lasting (a down payment, equipment): a cash
//                  outflow that is NOT lifestyle spending, so it stays out of expense totals.
//   []             no direct spending: a retirement/passive-income corpus can only be returned to cash
//                  (then spent through the normal flows), never "spent" from the goal itself.
const spendable = (reasons: string[], modes: GoalSpendMode[] = ["EXPENSE"], balanceLabel = "Saved so far"): Omit<Row, "typeLabel"> => ({
  balanceLabel,
  spendModes: modes,
  defaultSpendMode: modes[0] ?? null,
  addSources: SOURCES,
  useReasons: reasons,
});

const ROWS: Record<string, Row> = {
  EMERGENCY_FUND: {
    typeLabel: "Emergency fund",
    ...spendable(["Medical emergency", "Job loss", "Urgent repair", "Family emergency"], ["EXPENSE"], "In your fund"),
  },
  HEALTHCARE_RESERVE: { typeLabel: "Healthcare reserve", ...spendable(["Hospital bill", "Medicines", "Insurance co-pay", "Check-up"]) },
  HOUSE: { typeLabel: "House", ...spendable(["Down payment", "Registration & stamp duty", "Interiors", "Part payment"], ["OTHER_OUTFLOW", "EXPENSE"]) },
  LAND: { typeLabel: "Land", ...spendable(["Booking amount", "Registration & stamp duty", "Part payment"], ["OTHER_OUTFLOW", "EXPENSE"]) },
  CAR: { typeLabel: "Car", ...spendable(["Down payment", "Insurance & registration", "Accessories"], ["OTHER_OUTFLOW", "EXPENSE"]) },
  MARRIAGE: { typeLabel: "Marriage", ...spendable(["Venue", "Catering", "Jewellery & clothes", "Travel"]) },
  CHILD_EDUCATION: { typeLabel: "Child education", ...spendable(["Tuition fees", "Books & supplies", "Admission fee", "Hostel"]) },
  VACATION: { typeLabel: "Vacation", ...spendable(["Flights", "Stay", "Activities", "Visa & insurance"]) },
  BUSINESS_EXPANSION: { typeLabel: "Business expansion", ...spendable(["Equipment", "Inventory", "Marketing", "Working capital"], ["OTHER_OUTFLOW", "EXPENSE"]) },
  FAMILY_SUPPORT: { typeLabel: "Family support", ...spendable(["Medical support", "Education support", "Household support"]) },
  OTHER: { typeLabel: "Other goal", ...spendable([], ["EXPENSE", "OTHER_OUTFLOW"]) },
  RETIREMENT: { typeLabel: "Retirement", balanceLabel: "Saved so far", spendModes: [], defaultSpendMode: null, addSources: SOURCES, useReasons: ["Returned to cash"] },
  EARLY_RETIREMENT: { typeLabel: "Early retirement", balanceLabel: "Saved so far", spendModes: [], defaultSpendMode: null, addSources: SOURCES, useReasons: ["Returned to cash"] },
  PASSIVE_INCOME: { typeLabel: "Passive income", balanceLabel: "Saved so far", spendModes: [], defaultSpendMode: null, addSources: SOURCES, useReasons: ["Returned to cash"] },
};

const FALLBACK: Row = { typeLabel: "Goal", ...spendable([], ["EXPENSE", "OTHER_OUTFLOW"]) };

const humanize = (type: string): string => type.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export function goalFundRules(type: string, backing: GoalFundBacking): GoalFundRulesDTO {
  const row = ROWS[type] ?? { ...FALLBACK, typeLabel: humanize(type) };
  // Coverage ("months of essential expenses") and a months-based target are properties of the emergency
  // RESERVE — the one place that is measured against essential spending.
  const reserve = type === "EMERGENCY_FUND" && backing === "RESERVE";
  return { ...row, supportsCoverage: reserve, supportsMonthsTarget: reserve };
}
