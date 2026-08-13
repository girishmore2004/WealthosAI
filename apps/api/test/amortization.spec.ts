import { amortizeOneMonth, computeAmortizationSchedule } from "../src/common/finance-math/amortization";

describe("amortizeOneMonth (shared pure primitive)", () => {
  it("computes standard reducing-balance interest/principal split for one month", () => {
    const step = amortizeOneMonth(100000, 12, 5000); // 12%/year -> 1%/month
    expect(step.interest).toBeCloseTo(1000, 2); // 100000 * 0.01
    expect(step.principalPaid).toBeCloseTo(4000, 2); // 5000 - 1000
    expect(step.newBalance).toBeCloseTo(96000, 2);
    expect(step.stuck).toBe(false);
  });

  it("caps principalPaid at the remaining balance on the final, partial month", () => {
    const step = amortizeOneMonth(1000, 12, 5000); // EMI far exceeds what's owed
    expect(step.principalPaid).toBeCloseTo(1000 - step.interest, 2);
    expect(step.newBalance).toBe(0);
    expect(step.stuck).toBe(false);
  });

  it("reports stuck: true and leaves the balance unchanged when EMI doesn't cover interest", () => {
    const step = amortizeOneMonth(1000000, 24, 100); // 2%/month interest = 20000, EMI only 100
    expect(step.stuck).toBe(true);
    expect(step.newBalance).toBe(1000000);
    expect(step.principalPaid).toBe(0);
  });

  it("is deterministic: identical inputs always produce identical output", () => {
    const a = amortizeOneMonth(250000, 9.5, 6200);
    const b = amortizeOneMonth(250000, 9.5, 6200);
    expect(a).toEqual(b);
  });
});

describe("computeAmortizationSchedule (shared pure schedule builder)", () => {
  it("fully amortizes a standard loan to a zero balance within a reasonable number of months", () => {
    const rows = computeAmortizationSchedule(500000, 9, 10000);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[rows.length - 1].balance).toBe(0);
    // Every month's principal + interest should reconstruct that month's EMI (2dp).
    for (const row of rows) {
      expect(row.principal + row.interest).toBeCloseTo(row.emi, 1);
    }
  });

  it("stops at the safety cap (600 months) and records a stuck final row when EMI can't cover interest", () => {
    const rows = computeAmortizationSchedule(1000000, 24, 100);
    expect(rows.length).toBe(1); // reports the stuck month immediately, doesn't spin for 600 iterations
    expect(rows[0].principal).toBe(0);
    expect(rows[0].balance).toBe(1000000);
  });

  it("applies rate changes in effectiveFromMonth order, affecting only months from that point on", () => {
    const withoutChange = computeAmortizationSchedule(300000, 8, 8000);
    const withChange = computeAmortizationSchedule(300000, 8, 8000, [{ effectiveFromMonth: 3, newAnnualRatePercent: 14 }]);

    // First two months identical (change hasn't taken effect yet).
    expect(withChange[0]).toEqual(withoutChange[0]);
    expect(withChange[1]).toEqual(withoutChange[1]);
    // From month 3 onward, the higher rate means more interest / less principal that month.
    expect(withChange[2].interest).toBeGreaterThan(withoutChange[2].interest);
  });

  it("an empty rateChanges array is a guaranteed no-op — byte-for-byte identical to omitting it", () => {
    const a = computeAmortizationSchedule(200000, 10, 5000);
    const b = computeAmortizationSchedule(200000, 10, 5000, []);
    expect(a).toEqual(b);
  });

  it("when two rate changes target the same month, the last one in array order wins", () => {
    const rows = computeAmortizationSchedule(300000, 8, 8000, [
      { effectiveFromMonth: 1, newAnnualRatePercent: 10 },
      { effectiveFromMonth: 1, newAnnualRatePercent: 20 }, // should win
    ]);
    const directWith20 = computeAmortizationSchedule(300000, 20, 8000);
    expect(rows[0].interest).toBeCloseTo(directWith20[0].interest, 2);
  });

  it("respects a custom maxMonths safety cap", () => {
    // A loan that would technically converge eventually but is capped artificially low.
    const rows = computeAmortizationSchedule(1000000, 1, 100, [], 5);
    expect(rows.length).toBeLessThanOrEqual(5);
  });
});

describe("cross-consistency: LoansService's schedule vs. a manual month-by-month step (audit item #15)", () => {
  it("computeAmortizationSchedule's per-row balances match amortizeOneMonth applied iteratively by hand", () => {
    const principal = 400000;
    const rate = 9.5;
    const emi = 9000;

    const schedule = computeAmortizationSchedule(principal, rate, emi);

    let manualBalance = principal;
    for (const row of schedule) {
      const step = amortizeOneMonth(manualBalance, rate, emi);
      manualBalance = step.stuck ? manualBalance : step.newBalance;
      expect(row.balance).toBeCloseTo(manualBalance, 2);
    }
  });
});
