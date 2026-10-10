import { Prisma } from "@wealthos/db";
import {
  computeCashModel,
  computeNetWorth,
  daysUntilDue,
  effectiveReceivableStatus,
  isDueSoon,
  receivableOutstanding,
  receivableStatusFor,
} from "../src/common/financial-facts/financial-formulas";

const D = (n: number | string) => new Prisma.Decimal(n);
const NOW = new Date("2026-10-10T12:00:00Z");
const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe("receivable formulas", () => {
  it("Receivable Outstanding = Total Given - Total Returned (spec Part 57: 5,000 → 2,000 back → 3,000 back)", () => {
    expect(receivableOutstanding(D(5000), D(0)).toFixed(2)).toBe("5000.00");
    expect(receivableOutstanding(D(5000), D(2000)).toFixed(2)).toBe("3000.00");
    expect(receivableOutstanding(D(5000), D(5000)).toFixed(2)).toBe("0.00");
  });

  it("does not clamp: a negative outstanding means bad data and must stay visible", () => {
    expect(receivableOutstanding(D(1000), D(1500)).toFixed(2)).toBe("-500.00");
  });

  it("derives the persisted status from how much has come back", () => {
    expect(receivableStatusFor(D(5000), D(0))).toBe("OUTSTANDING");
    expect(receivableStatusFor(D(5000), D(2000))).toBe("PARTIALLY_RETURNED");
    expect(receivableStatusFor(D(5000), D(5000))).toBe("FULLY_RETURNED");
  });

  describe("overdue / due soon (UTC calendar days)", () => {
    it("is overdue only AFTER the due date; due today is not overdue", () => {
      expect(effectiveReceivableStatus("OUTSTANDING", day("2026-10-09"), NOW)).toBe("OVERDUE");
      expect(effectiveReceivableStatus("PARTIALLY_RETURNED", day("2026-10-09"), NOW)).toBe("OVERDUE");
      expect(effectiveReceivableStatus("OUTSTANDING", day("2026-10-10"), NOW)).toBe("OUTSTANDING");
      expect(effectiveReceivableStatus("OUTSTANDING", null, NOW)).toBe("OUTSTANDING");
    });

    it("never marks a closed or cancelled receivable overdue", () => {
      expect(effectiveReceivableStatus("FULLY_RETURNED", day("2026-01-01"), NOW)).toBe("FULLY_RETURNED");
      expect(effectiveReceivableStatus("CANCELLED", day("2026-01-01"), NOW)).toBe("CANCELLED");
    });

    it("counts due-soon within the window, inclusive of today, excluding overdue and far-future", () => {
      expect(isDueSoon("OUTSTANDING", day("2026-10-10"), NOW)).toBe(true);
      expect(isDueSoon("OUTSTANDING", day("2026-10-17"), NOW)).toBe(true);
      expect(isDueSoon("OUTSTANDING", day("2026-10-18"), NOW)).toBe(false);
      expect(isDueSoon("OUTSTANDING", day("2026-10-09"), NOW)).toBe(false);
      expect(isDueSoon("OUTSTANDING", null, NOW)).toBe(false);
      expect(isDueSoon("FULLY_RETURNED", day("2026-10-12"), NOW)).toBe(false);
    });

    it("reports signed days until due (negative = overdue)", () => {
      expect(daysUntilDue(day("2026-10-13"), NOW)).toBe(3);
      expect(daysUntilDue(day("2026-10-07"), NOW)).toBe(-3);
      expect(daysUntilDue(null, NOW)).toBeNull();
    });
  });

  describe("cash and net-worth semantics (lending is not spending)", () => {
    const base = {
      income: D(65000),
      expenses: D(15000),
      investmentCashOutflow: D(0),
      investmentCashInflow: D(0),
      emergencyAvailableCashDelta: D(0),
      emergencyCashAmount: D(0),
      unclassifiedOutflow: D(0),
    };
    const worth = (cash: ReturnType<typeof computeCashModel>, outstanding: Prisma.Decimal) =>
      computeNetWorth({
        availableCash: cash.availableCash,
        emergencyCash: cash.emergencyCash,
        investments: D(0),
        property: D(0),
        business: D(0),
        otherAssets: outstanding,
        loans: D(0),
        creditCardOutstanding: D(0),
        otherLiabilities: D(0),
      }).netWorth;

    it("giving ₹5,000: cash −5,000, receivable +5,000, net worth unchanged, expenses unchanged", () => {
      const before = computeCashModel(base);
      const after = computeCashModel({ ...base, otherCashOutflow: D(5000) });
      expect(before.availableCash.minus(after.availableCash).toFixed(2)).toBe("5000.00");
      expect(worth(after, receivableOutstanding(D(5000), D(0))).toFixed(2)).toBe(worth(before, D(0)).toFixed(2));
      expect(base.expenses.toFixed(2)).toBe("15000.00"); // the expense input never moved
    });

    it("₹2,000 returned: cash +2,000, receivable 3,000, net worth still unchanged", () => {
      const before = computeCashModel(base);
      const after = computeCashModel({ ...base, otherCashOutflow: D(5000), otherCashInflow: D(2000) });
      expect(after.availableCash.minus(before.availableCash).toFixed(2)).toBe("-3000.00");
      expect(worth(after, receivableOutstanding(D(5000), D(2000))).toFixed(2)).toBe(worth(before, D(0)).toFixed(2));
    });

    it("fully returned: cash fully restored, receivable zero", () => {
      const before = computeCashModel(base);
      const after = computeCashModel({ ...base, otherCashOutflow: D(5000), otherCashInflow: D(5000) });
      expect(after.availableCash.toFixed(2)).toBe(before.availableCash.toFixed(2));
      expect(receivableOutstanding(D(5000), D(5000)).toFixed(2)).toBe("0.00");
    });
  });
});
