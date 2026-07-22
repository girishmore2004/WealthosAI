import { computeMonthlySurplus, maxAffordablePrincipal } from "../src/ai/scenario-studio/affordability.util";
import { calculateEmi } from "../src/simulator/simulator.engine";

describe("computeMonthlySurplus", () => {
  it("subtracts expenses and EMIs from income", () => {
    expect(computeMonthlySurplus(100000, 60000, 15000)).toBe(25000);
  });

  it("can go negative when committed spend exceeds income", () => {
    expect(computeMonthlySurplus(50000, 60000, 10000)).toBe(-20000);
  });
});

describe("maxAffordablePrincipal", () => {
  it("returns 0 for a non-positive max EMI or tenure", () => {
    expect(maxAffordablePrincipal(0, 8, 240)).toBe(0);
    expect(maxAffordablePrincipal(20000, 8, 0)).toBe(0);
  });

  it("round-trips through calculateEmi — the principal it returns produces (approximately) the given EMI", () => {
    const maxEmi = 25000;
    const rate = 8.5;
    const tenure = 240;
    const principal = maxAffordablePrincipal(maxEmi, rate, tenure);
    const impliedEmi = calculateEmi(principal, rate, tenure);
    expect(impliedEmi).toBeCloseTo(maxEmi, 1);
  });

  it("handles a zero interest rate as a straight division", () => {
    expect(maxAffordablePrincipal(10000, 0, 100)).toBeCloseTo(1000000, 1);
  });
});
