import { currentFinancialYear, financialYearRange } from "../src/common/utils/financial-year.util";

describe("financial-year.util", () => {
  describe("currentFinancialYear", () => {
    it("returns the FY starting in the same calendar year for dates in April-December", () => {
      expect(currentFinancialYear(new Date(2026, 3, 1))).toBe("2026-27"); // April 1
      expect(currentFinancialYear(new Date(2026, 11, 31))).toBe("2026-27"); // Dec 31
    });

    it("returns the FY starting in the previous calendar year for dates in January-March", () => {
      expect(currentFinancialYear(new Date(2027, 0, 15))).toBe("2026-27"); // Jan 15
      expect(currentFinancialYear(new Date(2027, 2, 31))).toBe("2026-27"); // March 31
    });
  });

  describe("financialYearRange", () => {
    it("spans exactly April 1 to March 31 23:59:59 of the following year", () => {
      const { fyStart, fyEnd } = financialYearRange("2026-27");
      expect(fyStart).toEqual(new Date(2026, 3, 1));
      expect(fyEnd.getFullYear()).toBe(2027);
      expect(fyEnd.getMonth()).toBe(2); // March
      expect(fyEnd.getDate()).toBe(31);
    });
  });
});
