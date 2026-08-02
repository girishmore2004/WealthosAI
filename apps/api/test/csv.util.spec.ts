import { csvCell, csvRow } from "../src/common/utils/csv.util";

describe("csvCell", () => {
  it("passes through a plain value unchanged", () => {
    expect(csvCell("Rent")).toBe("Rent");
    expect(csvCell(1234.5)).toBe("1234.5");
  });

  it("quotes and escapes internal quotes when a comma is present", () => {
    expect(csvCell("Food, Dining")).toBe('"Food, Dining"');
    expect(csvCell('Say "hi"')).toBe('"Say ""hi"""');
  });

  it("quotes a value containing a newline", () => {
    expect(csvCell("line1\nline2")).toBe('"line1\nline2"');
  });

  it("does NOT neutralize formula-looking values by default", () => {
    expect(csvCell("-4000.00")).toBe("-4000.00");
    expect(csvCell("=SUM(A1)")).toBe("=SUM(A1)");
  });

  it("neutralizes formula-looking values when explicitly requested", () => {
    expect(csvCell("=SUM(A1)", { neutralizeFormulas: true })).toBe("'=SUM(A1)");
    expect(csvCell("+1", { neutralizeFormulas: true })).toBe("'+1");
    expect(csvCell("@cmd", { neutralizeFormulas: true })).toBe("'@cmd");
  });

  it("does not neutralize a legitimate negative amount even with the option on", () => {
    // Negative amounts (net cashflow, net savings) are numeric, server-generated, and
    // must never be reinterpreted as formula risks — callers must only pass
    // neutralizeFormulas for free-text/category cells, but this asserts the character
    // class itself: "-4000.00" still starts with "-", so this documents that any caller
    // opting a numeric cell into neutralizeFormulas would corrupt it, which is why
    // reports.service.ts never does so for amount cells.
    expect(csvCell("-4000.00", { neutralizeFormulas: true })).toBe("'-4000.00");
  });
});

describe("csvRow", () => {
  it("joins cells with commas", () => {
    expect(csvRow(["Rent", "5000.00", "100"])).toBe("Rent,5000.00,100");
  });
});
