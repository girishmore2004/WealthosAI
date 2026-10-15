import { ChunkerService } from "../src/ai/rag/chunking/chunker.service";
import { stripRepeatedPageBoilerplate } from "../src/ai/rag/chunking/page-boilerplate.util";

const FOOTER = [
  "Registered Office: No.1, New Tank Street, Chennai-600034.Phone:044-28288800",
  "ORDER NO. LOA/ENF-2/CSD/44/2024 VALIDITY PERIOD DT. 29-APR-24 TO 31-DEC -2027",
  "Super Star - UIN : SHAHLIP27049V022627 Star Flexi - UIN : SHAHLIA27050V022627",
];
function pdf(pages: string[][]): string {
  return pages.map((p, i) => `--- Page ${i + 1} ---\n${[...p, ...FOOTER, `Page ${i + 1} of ${pages.length}`].join("\n")}`).join("\n\n");
}

describe("stripRepeatedPageBoilerplate", () => {
  const text = pdf([
    ["This insurance policy is subject to various exclusions including pre-existing diseases"],
    ["Period of Insurance : From : 01-Oct-2026 To : Midnight of 30-Sep-2027", "Total Premium : Rs. 36,498/-"],
    ["Sum Insured Rs. 20,00,000 Cumulative Bonus Rs.0/-", "NA", "NA"],
    ["Cumulative Bonus 50% of sum insured"],
  ]);

  it("removes footers everywhere, including the first page, so their dates cannot be read as policy dates", () => {
    const out = stripRepeatedPageBoilerplate(text);
    expect(out).not.toContain("29-APR-24");
    expect(out).not.toContain("Registered Office");
    expect(out).not.toContain("Page 2 of 4");
  });

  it("keeps the real content and short table cells", () => {
    const out = stripRepeatedPageBoilerplate(text);
    expect(out).toContain("Period of Insurance : From : 01-Oct-2026");
    expect(out).toContain("Total Premium : Rs. 36,498/-");
    expect(out).toContain("NA");
  });

  it("keeps the first occurrence of a repeated short column header", () => {
    const rows = [1, 2, 3, 4].map((n) => [`Date Narration Withdrawal Balance`, `0${n}-Oct-2026 UPI Swiggy ${n}00.00`]);
    const out = stripRepeatedPageBoilerplate(pdf(rows));
    expect(out.match(/Date Narration Withdrawal Balance/g)).toHaveLength(1);
  });

  it("never removes a recurring transaction that is not on most pages", () => {
    const rows = [["Netflix subscription debit 649.00"], ["Salary credit 50000.00"], ["Netflix subscription debit 649.00"], ["Rent 12000.00"], ["Netflix subscription debit 649.00"]];
    const out = stripRepeatedPageBoilerplate(pdf(rows));
    expect(out.match(/Netflix subscription debit/g)).toHaveLength(3);
  });

  it("returns text without page markers, or with fewer than 3 pages, unchanged", () => {
    expect(stripRepeatedPageBoilerplate("a b c\na b c\na b c")).toBe("a b c\na b c\na b c");
    const two = pdf([["one two three"], ["four five six"]]);
    expect(stripRepeatedPageBoilerplate(two)).toBe(two);
  });
});

describe("ChunkerService page-aware chunking", () => {
  const chunker = new ChunkerService();

  it("labels every chunk with its page and never mixes two pages in one chunk", () => {
    const text = "Policy summary text before the pages.\n\n--- Page 1 ---\nAlpha facts here.\n\n--- Page 2 ---\nPeriod of Insurance 01-Oct-2026. Total Premium Rs. 36,498.";
    const chunks = chunker.chunk(text);
    expect(chunks.map((c) => c.text)).toEqual([
      "Policy summary text before the pages.",
      "[Page 1] Alpha facts here.",
      "[Page 2] Period of Insurance 01-Oct-2026. Total Premium Rs. 36,498.",
    ]);
    expect(chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    expect(chunks[2].parentText.startsWith("[Page 2] ")).toBe(true);
  });

  it("skips pages with no text", () => {
    const chunks = chunker.chunk("--- Page 1 ---\nReal content here.\n\n--- Page 2 ---\n(no text detected on this page)");
    expect(chunks).toHaveLength(1);
  });

  it("chunks text without page markers exactly as before", () => {
    const chunks = chunker.chunk("This is a short document about a home loan.");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe("This is a short document about a home loan.");
  });
});
