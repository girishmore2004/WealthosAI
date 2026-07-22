import { normalizeMerchantText, groupByNormalizedMerchant } from "../src/ai/copilot-ingestion/merchant/merchant-normalization";

describe("normalizeMerchantText", () => {
  it("strips a POS prefix and trailing reference number", () => {
    expect(normalizeMerchantText("POS AMAZON.IN 4829102")).toBe("Amazon.in");
  });

  it("strips a UPI prefix", () => {
    expect(normalizeMerchantText("UPI-SWIGGY BANGALORE")).toBe("Swiggy Bangalore");
  });

  it("strips a masked card suffix", () => {
    expect(normalizeMerchantText("NETFLIX.COM **1234")).toBe("Netflix.com");
  });

  it("collapses extra whitespace", () => {
    expect(normalizeMerchantText("  AMAZON    RETAIL  ")).toBe("Amazon Retail");
  });

  it("leaves an already-mixed-case merchant name untouched (word-level)", () => {
    expect(normalizeMerchantText("PayTM Recharge")).toBe("PayTM Recharge");
  });

  it("falls back to the trimmed raw string if normalization would produce nothing", () => {
    expect(normalizeMerchantText("   ")).toBe("");
  });
});

describe("groupByNormalizedMerchant", () => {
  it("groups items whose merchant strings normalize to the same value, even with different reference numbers", () => {
    const items = [{ merchantRaw: "POS AMAZON.IN 111111" }, { merchantRaw: "POS AMAZON.IN 222222" }, { merchantRaw: "UPI-SWIGGY BANGALORE" }];
    const groups = groupByNormalizedMerchant(items);
    expect(groups.size).toBe(2);
    expect(groups.get("amazon.in")).toHaveLength(2);
  });
});
