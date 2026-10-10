import { Test } from "@nestjs/testing";
import { computeMissedOccurrences, nextOccurrenceDate } from "../src/common/recurrence/recurrence.util";
import { RecurrenceGeneratorService } from "../src/common/recurrence/recurrence-generator.service";
import { PrismaService } from "../src/prisma/prisma.service";
import { applyRuleChanges, resolveExpenseRule, ruleFromRow, touchesRule } from "../src/common/recurrence/recurrence-template.util";
import { IncomeService } from "../src/income/income.service";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

describe("every cadence yields exactly one occurrence per period (spec Part 60)", () => {
  it.each([
    ["WEEKLY", "2026-10-05", "2026-10-12"],
    ["BIWEEKLY", "2026-10-05", "2026-10-19"],
    ["MONTHLY", "2026-10-05", "2026-11-05"],
    ["QUARTERLY", "2026-10-05", "2027-01-05"],
    ["YEARLY", "2026-10-05", "2027-10-05"],
  ] as const)("%s: the next occurrence after %s is %s", (cadence, from, expected) => {
    expect(iso(nextOccurrenceDate(d(from), cadence)!)).toBe(expected);
  });

  it("BIWEEKLY is every 14 days — 26 a year, NOT twice a month", () => {
    // The template row is the first real payment (2 Jan); the engine generates the ones AFTER it.
    const later = computeMissedOccurrences(d("2026-01-02"), "BIWEEKLY", d("2026-12-31"), { maxOccurrences: 100 });
    const all = [d("2026-01-02"), ...later];
    expect(later).toHaveLength(25); // 16 Jan … 18 Dec; the 26th payment is 1 Jan 2027
    expect(all.filter((x) => x < d("2026-12-31"))).toHaveLength(26); // 26 payments in 52 weeks, counting the first
    all.forEach((occ, i) => i > 0 && expect(occ.getTime() - all[i - 1].getTime()).toBe(14 * 86_400_000));
    expect(new Set(all.map(iso)).size).toBe(26); // no duplicates
    // January 2026 happens to hold two of them (16th and 30th); other months can hold three.
    expect(later.filter((x) => x.getUTCMonth() === 0)).toHaveLength(2);
  });

  it("BIWEEKLY crosses month and year boundaries without drifting", () => {
    expect(iso(nextOccurrenceDate(d("2026-12-25"), "BIWEEKLY")!)).toBe("2027-01-08");
    expect(iso(nextOccurrenceDate(d("2026-02-20"), "BIWEEKLY")!)).toBe("2026-03-06");
  });

  it("missed biweekly periods are backfilled one by one, never ahead of today", () => {
    const got = computeMissedOccurrences(d("2026-09-01"), "BIWEEKLY", d("2026-10-10")).map(iso);
    expect(got).toEqual(["2026-09-15", "2026-09-29"]); // 2026-10-13 is still in the future
  });

  it("an end date stops generation", () => {
    const got = computeMissedOccurrences(d("2026-09-01"), "BIWEEKLY", d("2026-12-31"), { endDate: d("2026-10-01") }).map(iso);
    expect(got).toEqual(["2026-09-15", "2026-09-29"]);
  });

  it("monthly still clamps to month end (existing behaviour is unchanged)", () => {
    expect(iso(nextOccurrenceDate(d("2026-01-31"), "MONTHLY")!)).toBe("2026-02-28");
  });
});

describe("BIWEEKLY income feeds the monthly forecast (every cadence map knows it)", () => {
  const mockPrisma = { client: { income: { findMany: jest.fn() } } };
  let service: IncomeService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({ providers: [IncomeService, { provide: PrismaService, useValue: mockPrisma }] }).compile();
    service = moduleRef.get(IncomeService);
  });

  it("prorates a biweekly salary to ~2.17 pay periods a month, not zero and not a crash", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([{ amount: 30000, recurrence: "BIWEEKLY" }]);
    expect(await service.monthlyForecast("u1")).toBeCloseTo(65100, -1); // 26 × 30,000 / 12 = 65,000
  });

  it("the breakdown includes a BIWEEKLY bucket instead of throwing", async () => {
    mockPrisma.client.income.findMany.mockResolvedValue([
      { amount: 30000, recurrence: "BIWEEKLY", label: "Salary" },
      { amount: 90000, recurrence: "MONTHLY", label: "Other" },
    ]);
    const out = await service.monthlyForecastBreakdown("u1");
    expect(out.byRecurrence.BIWEEKLY).toBeCloseTo(65100, -1);
    expect(out.byRecurrence.MONTHLY).toBe(90000);
  });
});

describe("recurrence rule snapshot (template vs history)", () => {
  const row = { categoryId: "c1", merchant: "Netflix", amount: 999, paymentMethod: "UPI", notes: null, flowType: "EXPENSE" };

  it("with no snapshot (every existing row) the row's own values ARE the rule — behaviour unchanged", () => {
    expect(resolveExpenseRule({ ...row, recurrenceTemplate: null })).toEqual(ruleFromRow(row));
    expect(resolveExpenseRule(row).amount).toBe(999);
  });

  it("a snapshot wins field by field", () => {
    const rule = resolveExpenseRule({ ...row, recurrenceTemplate: { amount: "1100.00", merchant: "Netflix Premium" } });
    expect(rule).toMatchObject({ amount: "1100.00", merchant: "Netflix Premium", categoryId: "c1", paymentMethod: "UPI" });
  });

  it("a damaged snapshot can never break generation: bad fields fall back to the row's own values", () => {
    const rule = resolveExpenseRule({ ...row, recurrenceTemplate: { amount: "abc", paymentMethod: "BARTER", categoryId: "", flowType: 7, merchant: 12 } });
    expect(rule).toMatchObject({ amount: 999, paymentMethod: "UPI", categoryId: "c1", flowType: "EXPENSE", merchant: "Netflix" });
    expect(resolveExpenseRule({ ...row, recurrenceTemplate: "garbage" })).toEqual(ruleFromRow(row));
    expect(resolveExpenseRule({ ...row, recurrenceTemplate: { amount: -5 } }).amount).toBe(999);
    expect(resolveExpenseRule({ ...row, recurrenceTemplate: [] })).toEqual(ruleFromRow(row));
  });

  it("applyRuleChanges merges onto the current rule and stores amount as a fixed 2-decimal string", () => {
    const out = applyRuleChanges(ruleFromRow(row), { amount: 1234.5, merchant: null });
    expect(out).toEqual({ categoryId: "c1", merchant: null, amount: "1234.50", paymentMethod: "UPI", notes: null, flowType: "EXPENSE" });
  });

  it("touchesRule only reports fields that feed future occurrences", () => {
    expect(touchesRule({ amount: 5 })).toBe(true);
    expect(touchesRule({ flowType: "OTHER_OUTFLOW" })).toBe(true);
    expect(touchesRule({ spentAt: "2026-01-01" })).toBe(false);
    expect(touchesRule({})).toBe(false);
  });
});

describe("the generator creates occurrences from the RULE, not the template row", () => {
  const db: any = {
    income: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    expense: { findMany: jest.fn(), create: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    recurringEventLog: { create: jest.fn().mockResolvedValue({}) },
    auditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn(),
  };
  db.$transaction.mockImplementation(async (fn: (tx: any) => Promise<unknown>) => fn(db));
  const svc = new RecurrenceGeneratorService({ client: db } as never);

  const template = (over: Record<string, unknown> = {}) => ({
    id: "t", userId: "u1", categoryId: "c1", merchant: "Gym", amount: 1500, currency: "INR", paymentMethod: "CARD", notes: null,
    flowType: "EXPENSE", recurrence: "MONTHLY", spentAt: d("2026-08-01"), nextOccurrenceAt: d("2026-09-01"), recurrenceEndDate: null,
    recurrenceActive: true, recurrenceTemplate: null, ...over,
  });
  const runWith = async (t: Record<string, unknown>) => {
    db.expense.create.mockClear();
    db.expense.create.mockResolvedValue({ id: "gen" });
    db.expense.findMany.mockResolvedValue([t]);
    await svc.generateForUser("u1");
    return db.expense.create.mock.calls[0][0].data;
  };

  it("with no snapshot it copies the template row exactly as before", async () => {
    expect(await runWith(template())).toMatchObject({ amount: 1500, merchant: "Gym", paymentMethod: "CARD", flowType: "EXPENSE", generatedFromRecurringId: "t" });
  });

  it("uses the edited rule while the template's own historical row keeps its recorded value", async () => {
    const data = await runWith(template({ recurrenceTemplate: { categoryId: "c1", merchant: "Gym Plus", amount: "1800.00", paymentMethod: "UPI", notes: null, flowType: "EXPENSE" } }));
    expect(data).toMatchObject({ amount: "1800.00", merchant: "Gym Plus", paymentMethod: "UPI" });
  });

  it("a template of 'other outflow' generates other-outflow rows, not ordinary expenses", async () => {
    expect((await runWith(template({ flowType: "OTHER_OUTFLOW" }))).flowType).toBe("OTHER_OUTFLOW");
  });

  it("generated rows are plain occurrences (not themselves active templates)", async () => {
    expect(await runWith(template())).toMatchObject({ isRecurring: true, recurrenceActive: false });
  });
});
