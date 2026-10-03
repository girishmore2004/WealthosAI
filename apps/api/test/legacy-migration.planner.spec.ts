import {
  LegacyExpenseInput,
  matchesInvestment,
  planLegacyMigration,
  summarize,
} from "../src/financial-core/legacy-migration/legacy-migration.planner";

const exp = (o: Partial<LegacyExpenseInput> & { id: string }): LegacyExpenseInput => ({
  amount: "10000.00",
  spentAt: new Date("2026-09-05T00:00:00Z"),
  merchant: null,
  notes: null,
  categoryName: "SIP",
  ...o,
});
const base = { alreadyMigratedExpenseIds: new Set<string>(), existingContributions: [] };
const funds = [
  { id: "inv-axis", name: "Axis Bluechip Fund" },
  { id: "inv-parag", name: "Parag Parikh Flexi Cap Fund" },
];

describe("legacy migration planner", () => {
  it("maps an emergency-fund expense to a reserve allocation", () => {
    const [r] = planLegacyMigration({ ...base, investments: funds, expenses: [exp({ id: "e1", categoryName: "Emergency Fund", amount: "7000.00" })] });
    expect(r).toMatchObject({ status: "MIGRATED", target: "EMERGENCY_ALLOCATION", amount: "7000.00" });
  });

  it("maps a SIP expense to a contribution only when exactly one investment matches", () => {
    const [r] = planLegacyMigration({ ...base, investments: funds, expenses: [exp({ id: "e1", merchant: "Axis Bluechip Fund SIP" })] });
    expect(r).toMatchObject({ status: "MIGRATED", target: "INVESTMENT_CONTRIBUTION", investmentId: "inv-axis", periodKey: "2026-09" });
  });

  it("does NOT guess: no match -> WARNING", () => {
    const [r] = planLegacyMigration({ ...base, investments: funds, expenses: [exp({ id: "e1", merchant: "Some Bank" })] });
    expect(r.status).toBe("WARNING");
    expect(r.target).toBe("NONE");
  });

  it("does NOT guess: ambiguous match -> WARNING", () => {
    const dup = [...funds, { id: "inv-axis2", name: "Axis Bluechip Fund" }];
    const [r] = planLegacyMigration({ ...base, investments: dup, expenses: [exp({ id: "e1", merchant: "Axis Bluechip Fund" })] });
    expect(r.status).toBe("WARNING");
    expect(r.reason).toMatch(/Ambiguous/);
  });

  it("skips rows that were already migrated (idempotent re-run)", () => {
    const [r] = planLegacyMigration({
      investments: funds,
      existingContributions: [],
      alreadyMigratedExpenseIds: new Set(["e1"]),
      expenses: [exp({ id: "e1", merchant: "Axis Bluechip Fund" })],
    });
    expect(r.status).toBe("SKIPPED");
  });

  it("flags a second legacy row for the same investment+month as DUPLICATE (same amount), migrating only the first", () => {
    const rows = planLegacyMigration({
      ...base,
      investments: funds,
      expenses: [
        exp({ id: "e1", merchant: "Axis Bluechip Fund", spentAt: new Date("2026-09-05T00:00:00Z") }),
        exp({ id: "e2", merchant: "Axis Bluechip Fund", spentAt: new Date("2026-09-20T00:00:00Z") }),
      ],
    });
    expect(rows.map((r) => r.status)).toEqual(["MIGRATED", "DUPLICATE"]);
  });

  it("WARNs (not duplicates) when the month already has a DIFFERENT contribution amount", () => {
    const [r] = planLegacyMigration({
      alreadyMigratedExpenseIds: new Set(),
      investments: funds,
      existingContributions: [{ investmentId: "inv-axis", occurredAt: new Date("2026-09-01T00:00:00Z"), amount: "5000.00" }],
      expenses: [exp({ id: "e1", merchant: "Axis Bluechip Fund" })],
    });
    expect(r.status).toBe("WARNING");
  });

  it("summarizes outcomes", () => {
    expect(summarize([{ status: "MIGRATED" }, { status: "WARNING" }, { status: "MIGRATED" }])).toEqual({
      MIGRATED: 2, SKIPPED: 0, DUPLICATE: 0, WARNING: 1, ERROR: 0,
    });
  });

  it("matching ignores generic words so 'Fund' alone never matches everything", () => {
    expect(matchesInvestment("Fund", funds[0])).toBe(false);
    expect(matchesInvestment("parag parikh flexi cap", funds[1])).toBe(true);
  });
});
