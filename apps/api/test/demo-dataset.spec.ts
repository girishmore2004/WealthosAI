import { buildDemoDataset } from "../../../packages/db/prisma/demo/demo-dataset";

const ASOF = new Date("2026-10-11T00:00:00.000Z");
const d = buildDemoDataset(ASOF);
const paise = (n: number) => Math.round(n * 100);

type Ev = { at: number; delta: number; what: string };

function cashEvents(): Ev[] {
  const ev: Ev[] = [];
  for (const i of d.incomes) ev.push({ at: i.receivedAt.getTime(), delta: paise(i.amount), what: `income ${i.label}` });
  for (const e of d.expenses) ev.push({ at: e.spentAt.getTime(), delta: -paise(e.amount), what: `expense ${e.merchant}` });
  for (const c of d.cashflows) {
    if (c.type === "CONTRIBUTION") ev.push({ at: c.occurredAt.getTime(), delta: -paise(c.amount), what: `contribution ${c.investmentKey}` });
    if (c.type === "WITHDRAWAL") ev.push({ at: c.occurredAt.getTime(), delta: paise(c.amount), what: `withdrawal ${c.investmentKey}` });
  }
  for (const e of d.emergencyEntries) {
    ev.push({ at: e.occurredAt.getTime(), delta: e.type === "ALLOCATE" ? -paise(e.amount) : paise(e.amount), what: `emergency ${e.type}` });
  }
  for (const r of d.receivables) {
    ev.push({ at: r.givenAt.getTime(), delta: -paise(r.originalAmount), what: `lent ${r.person}` });
    for (const p of r.repayments) ev.push({ at: p.returnedAt.getTime(), delta: paise(p.amount), what: `repaid ${r.person}` });
  }
  // inflows before outflows on the same instant, so same-day salary can fund same-day spends
  return ev.sort((a, b) => a.at - b.at || b.delta - a.delta);
}

describe("demo dataset", () => {
  it("is deterministic", () => {
    const again = buildDemoDataset(ASOF);
    expect(JSON.stringify(again)).toEqual(JSON.stringify(d));
  });

  it("covers 84 months", () => {
    expect(d.facts.months).toBeGreaterThanOrEqual(84);
  });

  it("never lets cash go negative on any day", () => {
    let cash = 0;
    let lowest = Infinity;
    for (const e of cashEvents()) {
      cash += e.delta;
      lowest = Math.min(lowest, cash);
      if (cash < 0) throw new Error(`cash negative (${cash / 100}) after ${e.what} at ${new Date(e.at).toISOString()}`);
    }
    expect(lowest).toBeGreaterThanOrEqual(0);
  });

  it("gives a positive, plausible net worth for a 25 LPA / 7-year profile", () => {
    const cash = cashEvents().reduce((s, e) => s + e.delta, 0) / 100;
    const emergency = d.emergencyEntries.reduce((s, e) => s + (e.type === "ALLOCATE" ? e.amount : -e.amount), 0);
    const latest = new Map<string, number>();
    for (const v of [...d.valuations].sort((a, b) => a.valuedAt.getTime() - b.valuedAt.getTime())) latest.set(v.investmentKey, v.value);
    const invest = d.investments.reduce((s, i) => s + (latest.get(i.key) ?? i.currentValue), 0);
    const property = d.properties.reduce((s, p) => s + p.currentValue, 0);
    const receivables = d.receivables.reduce(
      (s, r) => s + r.originalAmount - r.repayments.reduce((a, p) => a + p.amount, 0),
      0,
    );
    const loans = d.loans.reduce((s, l) => s + l.outstandingPrincipal, 0);
    const netWorth = cash + emergency + invest + property + receivables - loans;
    expect(cash).toBeGreaterThanOrEqual(0);
    expect(netWorth).toBeGreaterThan(2_500_000);
    expect(netWorth).toBeLessThan(15_000_000);
  });

  it("has no duplicate investment cashflow periods or valuation dates", () => {
    const cf = new Set<string>();
    for (const c of d.cashflows) {
      if (!c.periodKey) continue;
      const k = `${c.investmentKey}|${c.type}|${c.periodKey}`;
      expect(cf.has(k)).toBe(false);
      cf.add(k);
    }
    const vs = new Set<string>();
    for (const v of d.valuations) {
      const k = `${v.investmentKey}|${v.valuedAt.toISOString()}`;
      expect(vs.has(k)).toBe(false);
      vs.add(k);
    }
  });

  it("has exactly one recurring template per series and valid links", () => {
    const keys = new Set(d.incomes.map((i) => i.key));
    for (const i of d.incomes) if (i.templateKey) expect(keys.has(i.templateKey)).toBe(true);
    const templates = new Set(d.incomes.filter((i) => i.templateKey).map((i) => i.templateKey));
    for (const t of templates) {
      const row = d.incomes.find((i) => i.key === t)!;
      expect(row.templateKey).toBeNull();
    }
  });

  it("uses only known categories and no SAVINGS expenses", () => {
    const names = new Set(d.categories.map((c) => c.name));
    for (const e of d.expenses) {
      expect(names.has(e.categoryName)).toBe(true);
      expect(e.categoryName.toUpperCase()).not.toBe("SAVINGS");
    }
  });

  it("has no future-dated rows", () => {
    const max = ASOF.getTime() + 24 * 3600 * 1000;
    for (const i of d.incomes) expect(i.receivedAt.getTime()).toBeLessThanOrEqual(max);
    for (const e of d.expenses) expect(e.spentAt.getTime()).toBeLessThanOrEqual(max);
  });

  it("EMI amounts match the loan formula", () => {
    for (const l of d.loans) expect(l.emiAmount).toBeGreaterThan(0);
    expect(d.loans.length).toBe(2);
  });

  it("links every insurance premium expense to its policy, once per policy and year", () => {
    const keys = new Set(d.policies.map((p) => p.key));
    const seen = new Set<string>();
    const premiums = d.expenses.filter((e) => e.categoryName === "Insurance");
    expect(premiums.length).toBeGreaterThan(0);
    for (const e of premiums) {
      expect(e.policyKey && keys.has(e.policyKey)).toBe(true);
      expect(e.sourceReference).toBe(String(e.spentAt.getUTCFullYear()));
      const k = `${e.policyKey}|${e.sourceReference}`;
      expect(seen.has(k)).toBe(false);
      seen.add(k);
    }
  });
});
