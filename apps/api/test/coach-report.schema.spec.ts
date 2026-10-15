import { minimalReport, validateCoachReport } from "../src/ai/coach/report/coach-report.schema";
import { ReportBuilder, cleanText } from "../src/ai/coach/report/report-builder";

describe("coach report schema", () => {
  it("accepts the minimal fallback report", () => {
    expect(validateCoachReport(minimalReport({ directAnswer: "ok" })).ok).toBe(true);
  });

  it("rejects an invalid report and reports paths, not values", () => {
    const bad = { ...minimalReport({ directAnswer: "ok" }), evidenceSufficiency: "great", financialSnapshot: { asOf: "x", currency: "USD", items: [] } };
    const r = validateCoachReport(bad);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join(" ")).not.toContain("great");
  });

  it("rejects non-finite numbers so NaN/Infinity can never be shown as a figure", () => {
    const base = minimalReport({ directAnswer: "ok" });
    const bad = { ...base, financialSnapshot: { ...base.financialSnapshot, items: [{ key: "a", label: "A", value: NaN, display: "x", unit: "INR", quality: "verified" }] } };
    expect(validateCoachReport(bad).ok).toBe(false);
  });

  it("bounds oversized content", () => {
    expect(validateCoachReport({ ...minimalReport({ directAnswer: "ok" }), assumptions: Array.from({ length: 50 }, () => "a") }).ok).toBe(false);
  });
});

describe("ReportBuilder", () => {
  it("falls back to a valid minimal report when the assembled one is invalid", () => {
    const b = new ReportBuilder(new Date("2026-10-15T00:00:00Z"));
    b.item("k", "Bad", Infinity, "x", "INR", "verified");
    const r = b.build({ directAnswer: "Answer", answerType: "fact", sufficiency: "sufficient" });
    expect(r.directAnswer).toBe("Answer");
    expect(r.financialSnapshot.items).toHaveLength(0);
    expect(r.dataGaps[0].code).toBe("REPORT_INVALID");
    expect(r.metadata.partial).toBe(true);
  });

  it("never turns a missing money value into zero", () => {
    const b = new ReportBuilder(new Date("2026-10-15T00:00:00Z"));
    b.money("income", "Income", null);
    expect(b.snapshot[0]).toMatchObject({ value: null, display: "Not recorded", quality: "missing" });
  });

  it("downgrades 'sufficient' when a source failed", () => {
    const b = new ReportBuilder(new Date());
    b.noteSessionFailures([{ source: "loans", ok: false, reason: "timed out" }]);
    expect(b.build({ directAnswer: "a", answerType: "fact", sufficiency: "sufficient" }).evidenceSufficiency).toBe("partial");
  });

  it("cleanText strips control characters and truncates", () => {
    expect(cleanText("a\u0000b\n\n c", 50)).toBe("a b c");
    expect(cleanText("x".repeat(20), 10)).toHaveLength(10);
  });
});
