import { dueSipPeriods, supportsContributionSchedule, validateCashflowForType, MAX_SIP_PERIODS_PER_RUN } from "../src/investments/investment-sip.util";
import { isValidPremiumPeriod, premiumPeriodKey } from "../src/insurance/insurance-premium.util";

const d = (s: string) => new Date(`${s}T00:00:00Z`);

describe("SIP schedule", () => {
  it("returns one period per elapsed month, never a future one", () => {
    const p = dueSipPeriods({ contributionDay: 5, startDate: d("2026-07-01"), endDate: null }, d("2026-09-10"));
    expect(p.map((x) => x.periodKey)).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(dueSipPeriods({ contributionDay: 5, startDate: d("2026-07-01"), endDate: null }, d("2026-09-04")).map((x) => x.periodKey)).toEqual(["2026-07", "2026-08"]);
  });

  it("clamps day 31 to the month length", () => {
    const [feb] = dueSipPeriods({ contributionDay: 31, startDate: d("2026-02-01"), endDate: null }, d("2026-02-28"));
    expect(feb.occurredAt.toISOString().slice(0, 10)).toBe("2026-02-28");
  });

  it("respects the end date and the start date", () => {
    expect(dueSipPeriods({ contributionDay: 5, startDate: d("2026-07-10"), endDate: d("2026-09-01") }, d("2026-12-01")).map((x) => x.periodKey)).toEqual(["2026-08"]);
  });

  it("caps a runaway backfill", () => {
    expect(dueSipPeriods({ contributionDay: 1, startDate: d("2000-01-01"), endDate: null }, d("2026-10-03"))).toHaveLength(MAX_SIP_PERIODS_PER_RUN);
  });

  it("keeps EPF/NPS-only cashflows off unrelated types and stocks off schedules", () => {
    expect(validateCashflowForType("MUTUAL_FUND", "EMPLOYER_CONTRIBUTION")).not.toBeNull();
    expect(validateCashflowForType("EPF", "EMPLOYER_CONTRIBUTION")).toBeNull();
    expect(validateCashflowForType("STOCK", "INTEREST")).not.toBeNull();
    expect(supportsContributionSchedule("STOCK")).toBe(false);
    expect(supportsContributionSchedule("MUTUAL_FUND")).toBe(true);
  });
});

describe("insurance premium period keys", () => {
  const date = d("2026-09-15");
  it("derives keys per frequency", () => {
    expect(premiumPeriodKey("MONTHLY", date)).toBe("2026-09");
    expect(premiumPeriodKey("QUARTERLY", date)).toBe("2026-Q3");
    expect(premiumPeriodKey("YEARLY", date)).toBe("2026");
    expect(premiumPeriodKey("WEEKLY", date)).toBe("2026-W38");
    expect(premiumPeriodKey("ONE_TIME", date)).toBe("ONE_TIME");
  });
  it("validates explicit periods against the frequency", () => {
    expect(isValidPremiumPeriod("MONTHLY", "2026-13")).toBe(false);
    expect(isValidPremiumPeriod("QUARTERLY", "2026-Q5")).toBe(false);
    expect(isValidPremiumPeriod("YEARLY", "2026-09")).toBe(false);
    expect(isValidPremiumPeriod("YEARLY", "2026")).toBe(true);
  });
});
