import { groupExpensesByCategory } from "../src/common/utils/report-aggregation.util";

describe("groupExpensesByCategory", () => {
  it("groups by category name, sums amounts, and sorts descending by amount", () => {
    const rows = groupExpensesByCategory(
      [
        { category: { name: "Groceries" }, amount: 3000 },
        { category: { name: "Rent" }, amount: 20000 },
        { category: { name: "Groceries" }, amount: 1500 },
      ],
      24500,
    );

    expect(rows[0]).toEqual({ category: "Rent", amount: "20000.00", percentOfTotal: 81.6 });
    expect(rows[1]).toEqual({ category: "Groceries", amount: "4500.00", percentOfTotal: 18.4 });
  });

  it("returns 0% for every row when totalExpenses is 0 (avoids division by zero)", () => {
    const rows = groupExpensesByCategory([{ category: { name: "Misc" }, amount: 0 }], 0);
    expect(rows[0].percentOfTotal).toBe(0);
  });

  it("returns an empty array for no expenses", () => {
    expect(groupExpensesByCategory([], 0)).toEqual([]);
  });
});
