import { FinancialFactsService } from "../src/common/financial-facts/financial-facts.service";

// ---------------------------------------------------------------------------------------
// The spec's canonical scenario (Parts 55, 58, 59, 62, 63), run through the REAL
// FinancialFactsService against a fake database:
//   Income 65,000 · normal expenses 15,000 · investment 10,000 · emergency fund 7,000 ·
//   receivable 5,000 · internal transfer 3,000
// The six categories must stay separate: nothing is lumped into "expenses".
// ---------------------------------------------------------------------------------------

interface Scenario {
  income: number;
  expenses: number;
  otherOutflow?: number;
  contributions?: number;
  emergency?: Array<{ type: string; amount: number }>;
  receivableGiven?: number;
  receivableReturned?: number;
  transfers?: number;
  investmentValue?: number; // latest dated valuation
  investmentCurrentValueField?: number; // legacy field
}

function build(sc: Scenario) {
  const sum = (n: number | undefined) => ({ _sum: { amount: n ?? null } });
  const db = {
    income: { aggregate: jest.fn(async () => sum(sc.income)) },
    expense: {
      aggregate: jest.fn(async ({ where }: any) => sum(where.flowType === "OTHER_OUTFLOW" ? sc.otherOutflow : sc.expenses)),
      findMany: jest.fn().mockResolvedValue([]), // no legacy SAVINGS rows
    },
    investmentCashflow: {
      groupBy: jest.fn(async () => (sc.contributions ? [{ type: "CONTRIBUTION", _sum: { amount: sc.contributions } }] : [])),
      findMany: jest.fn().mockResolvedValue([]),
    },
    emergencyFundEntry: {
      groupBy: jest.fn(async ({ where }: any) =>
        (sc.emergency ?? [])
          .filter((e) => !where.type || e.type === where.type)
          .map((e) => ({ type: e.type, _sum: { amount: e.amount } })),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    investment: {
      findMany: jest.fn(async () =>
        sc.investmentValue !== undefined || sc.investmentCurrentValueField !== undefined
          ? [
              {
                id: "i1",
                currentValue: sc.investmentCurrentValueField ?? 0,
                valuations: sc.investmentValue !== undefined ? [{ value: sc.investmentValue, valuedAt: new Date() }] : [],
              },
            ]
          : [],
      ),
    },
    property: { aggregate: jest.fn(async () => ({ _sum: { currentValue: null } })) },
    loan: { aggregate: jest.fn(async () => ({ _sum: { outstandingPrincipal: null } })) },
    receivable: { aggregate: jest.fn(async () => ({ _sum: { originalAmount: sc.receivableGiven ?? null } })) },
    receivableRepayment: { aggregate: jest.fn(async () => sum(sc.receivableReturned)) },
    accountTransfer: { aggregate: jest.fn(async () => sum(sc.transfers)) },
  };
  return new FinancialFactsService({ client: db } as never, {} as never, {} as never);
}

const base: Scenario = {
  income: 65000,
  expenses: 15000,
  contributions: 10000,
  emergency: [{ type: "ALLOCATE", amount: 7000 }],
  receivableGiven: 5000,
  transfers: 3000,
  investmentValue: 10000,
};

describe("money flow — the six categories stay separate (spec Part 55 / 63)", () => {
  it("reports each flow on its own and never reports expenses = 40,000", async () => {
    const flow = await build(base).getMoneyFlow("u1", "2026-10");

    expect(flow.income).toBe("65000.00");
    expect(flow.outflows).toEqual({
      expenses: "15000.00",
      investments: "10000.00",
      emergencyFund: "7000.00",
      receivablesGiven: "5000.00",
      otherOutflow: "0.00",
    });
    expect(flow.internalTransfers).toBe("3000.00");
    expect(flow.outflows.expenses).not.toBe("40000.00");
  });

  it("internal transfers are shown but are in no total", async () => {
    const flow = await build(base).getMoneyFlow("u1", "2026-10");
    expect(flow.totalGenuineOutflow).toBe("37000.00"); // 15k + 10k + 7k + 5k — the 3k transfer is excluded
    expect(flow.netCashFlow).toBe("28000.00"); // 65k − 37k
    const without = await build({ ...base, transfers: 0 }).getMoneyFlow("u1", "2026-10");
    expect(without.netCashFlow).toBe(flow.netCashFlow);
  });

  it("rates use only the right numerator: lending, emergency money and transfers never raise the expense rate", async () => {
    const flow = await build(base).getMoneyFlow("u1", "2026-10");
    expect(Number(flow.expenseRate)).toBeCloseTo(15000 / 65000, 6);
    expect(Number(flow.savingsRate)).toBeCloseTo(50000 / 65000, 6);
    expect(Number(flow.investmentRate)).toBeCloseTo(10000 / 65000, 6);
    expect(flow.percentOfIncome).toEqual({ expenses: 23.1, investments: 15.4, emergencyFund: 10.8, receivablesGiven: 7.7, otherOutflow: 0 });
  });

  it("has no rates or percentages (not zero, not NaN) when no income was recorded", async () => {
    const flow = await build({ income: 0, expenses: 500 }).getMoneyFlow("u1", "2026-10");
    expect(flow.expenseRate).toBeNull();
    expect(flow.percentOfIncome.expenses).toBeNull();
  });

  it("Part 57: giving ₹5,000 leaves expenses unchanged; ₹2,000 back raises cash, not income", async () => {
    const none = await build({ ...base, receivableGiven: 0 }).getMoneyFlow("u1", "2026-10");
    const lent = await build(base).getMoneyFlow("u1", "2026-10");
    const partlyBack = await build({ ...base, receivableReturned: 2000 }).getMoneyFlow("u1", "2026-10");

    expect(lent.outflows.expenses).toBe(none.outflows.expenses);
    expect(lent.income).toBe(none.income);
    expect(partlyBack.income).toBe("65000.00");
    expect(partlyBack.inflows.receivableRepayments).toBe("2000.00");
    expect(partlyBack.netCashFlow).toBe("30000.00"); // 28,000 + 2,000 returned
  });

  it("OTHER_OUTFLOW reduces cash but is not an expense", async () => {
    const flow = await build({ ...base, otherOutflow: 1200 }).getMoneyFlow("u1", "2026-10");
    expect(flow.outflows.expenses).toBe("15000.00");
    expect(flow.outflows.otherOutflow).toBe("1200.00");
    expect(flow.netCashFlow).toBe("26800.00");
    expect(Number(flow.expenseRate)).toBeCloseTo(15000 / 65000, 6);
  });
});

describe("financial position — cash, emergency cash and net worth (spec Part 58 / 59 / 62)", () => {
  it("dashboard figures after the full scenario, with no double counting", async () => {
    const p = await build(base).getFinancialPosition("u1");
    expect(p.cash.available).toBe("28000.00"); // 65k − 15k − 10k − 7k − 5k
    expect(p.cash.emergency).toBe("7000.00");
    expect(p.cash.total).toBe("35000.00");
    expect(p.receivables).toEqual({ given: "5000.00", returned: "0.00", outstanding: "5000.00" });
    // 28,000 cash + 7,000 emergency + 10,000 investment + 5,000 receivable = income − expenses = 50,000
    expect(p.netWorth).toBe("50000.00");
  });

  it("Part 58: valuing the ₹10,000 investment at ₹10,500 adds a ₹500 GAIN, not a contribution", async () => {
    const before = await build(base).getFinancialPosition("u1");
    const after = await build({ ...base, investmentValue: 10500 }).getFinancialPosition("u1");
    expect(after.cash.available).toBe(before.cash.available); // cash untouched
    expect(Number(after.netWorth) - Number(before.netWorth)).toBe(500);
    const flow = await build({ ...base, investmentValue: 10500 }).getMoneyFlow("u1", "2026-10");
    expect(flow.outflows.investments).toBe("10000.00"); // contribution unchanged
  });

  it("Part 59: using ₹3,000 from the emergency fund shrinks the reserve; only the real expense is counted", async () => {
    const used: Scenario = {
      ...base,
      expenses: 18000, // the 3,000 medical bill is a genuine expense
      emergency: [
        { type: "ALLOCATE", amount: 7000 },
        { type: "WITHDRAWAL", amount: 3000 },
      ],
    };
    const p = await build(used).getFinancialPosition("u1");
    expect(p.cash.emergency).toBe("4000.00"); // 7,000 − 3,000
    expect(p.cash.available).toBe("28000.00"); // 65k − 18k − 10k − 4k (net reserve) − 5k
    // Net worth fell by exactly the consumed 3,000: the withdrawal itself was not an expense or income.
    expect(p.netWorth).toBe("47000.00");
  });

  it("Part 57: lending then fully recovering restores cash and leaves net worth untouched throughout", async () => {
    const none = await build({ ...base, receivableGiven: 0, transfers: 0 }).getFinancialPosition("u1");
    const lent = await build(base).getFinancialPosition("u1");
    const back = await build({ ...base, receivableReturned: 5000 }).getFinancialPosition("u1");
    expect(lent.netWorth).toBe(none.netWorth);
    expect(Number(none.cash.available) - Number(lent.cash.available)).toBe(5000);
    expect(back.cash.available).toBe(none.cash.available); // fully restored
    expect(back.receivables.outstanding).toBe("0.00");
  });

  it("an internal transfer changes nothing about cash or net worth", async () => {
    const a = await build({ ...base, transfers: 0 }).getFinancialPosition("u1");
    const b = await build(base).getFinancialPosition("u1");
    expect(b.cash).toEqual(a.cash);
    expect(b.netWorth).toBe(a.netWorth);
  });
});
