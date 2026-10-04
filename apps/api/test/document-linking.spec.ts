import { BadRequestException, NotFoundException } from "@nestjs/common";
import { DocumentEntityService } from "../src/documents/document-entity.service";
import { DocumentReconciliationService } from "../src/documents/document-reconciliation.service";
import { comparePolicyFacts, extractPolicyFacts, extractionCoverage } from "../src/documents/extraction/policy-extractor";
import { buildFinancialFactSources } from "../src/ai/rag/indexing/financial-fact-sources";
import { detectDocumentDiscrepancies, detectUnlinkedDocuments } from "../src/financial-core/data-health/data-health.detectors";
import { maskIdentifier } from "../src/common/utils/mask.util";
import { RedactionService } from "../src/ai/gateway/redaction.service";

describe("DocumentEntityService — links must point at the caller's own records", () => {
  const model = () => ({ findFirst: jest.fn().mockResolvedValue({ id: "e1" }) });
  const build = () => {
    const client = { insurancePolicy: model(), investment: model(), loan: model(), property: model(), income: model(), taxDeduction: model(), business: model() };
    return { client, svc: new DocumentEntityService({ client } as never) };
  };

  it("accepts no link at all, and requires type and id together", async () => {
    const { svc } = build();
    expect(await svc.validateLink("u1", undefined, undefined)).toEqual({ entityType: null, entityId: null });
    expect(await svc.validateLink("u1", null, null)).toEqual({ entityType: null, entityId: null });
    await expect(svc.validateLink("u1", "POLICY", undefined)).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.validateLink("u1", undefined, "p1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    ["POLICY", "insurancePolicy"], ["INVESTMENT", "investment"], ["LOAN", "loan"], ["PROPERTY", "property"],
    ["INCOME", "income"], ["TAX", "taxDeduction"], ["BUSINESS", "business"],
  ])("verifies %s ownership through the user-scoped %s lookup", async (type, table) => {
    const { client, svc } = build();
    await expect(svc.validateLink("user-1", type, "ent-1")).resolves.toEqual({ entityType: type, entityId: "ent-1" });
    expect((client as Record<string, { findFirst: jest.Mock }>)[table].findFirst).toHaveBeenCalledWith({ where: { id: "ent-1", userId: "user-1" }, select: { id: true } });
  });

  it("refuses another user's record with a NotFound (ids cannot be probed)", async () => {
    const { client, svc } = build();
    client.insurancePolicy.findFirst.mockResolvedValue(null);
    await expect(svc.validateLink("attacker", "POLICY", "victim-policy")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("rejects unknown entity and document types", async () => {
    const { svc } = build();
    await expect(svc.validateLink("u1", "BANK_ACCOUNT", "x")).rejects.toBeInstanceOf(BadRequestException);
    expect(svc.validateDocumentType("POLICY_PDF")).toBe("POLICY_PDF");
    expect(svc.validateDocumentType(undefined)).toBeNull();
    expect(() => svc.validateDocumentType("MALWARE")).toThrow(BadRequestException);
  });
});

describe("policy extraction", () => {
  const text = `HDFC ERGO Health Insurance. Policy No: HEA12345678. Sum Insured: Rs. 10,00,000
    Total Premium Payable: ₹ 8,500.00  Renewal Date: 01/12/2026`;

  it("extracts labelled premium, coverage, renewal date (DD/MM/YYYY) and only the policy-number tail", () => {
    expect(extractPolicyFacts(text)).toEqual({ premiumAmount: "8500.00", coverageAmount: "1000000.00", renewalDate: "2026-12-01", policyNumberLast4: "5678" });
  });
  it("parses a written-out renewal date", () => {
    expect(extractPolicyFacts("Next premium due: 5 March 2027").renewalDate).toBe("2027-03-05");
  });
  it("returns nothing for text with no labelled values rather than guessing", () => {
    expect(extractPolicyFacts("Thank you for choosing us. Page 1 of 4")).toEqual({});
    expect(extractionCoverage({}).ratio).toBe(0);
  });
  it("never keeps more than the last four characters of the policy number", () => {
    expect(JSON.stringify(extractPolicyFacts(text))).not.toContain("HEA1234");
  });

  const db = { premiumAmount: "8500", coverageAmount: "1000000", renewalDate: new Date("2026-12-01T00:00:00Z") };
  it("reports no discrepancy when document and database agree", () => {
    const r = comparePolicyFacts(extractPolicyFacts(text), db);
    expect(r.discrepancies).toEqual([]);
    expect(r.matching).toEqual(["premiumAmount", "coverageAmount", "renewalDate"]);
  });
  it("flags a premium mismatch and keeps both values", () => {
    const r = comparePolicyFacts({ premiumAmount: "9200.00" }, db);
    expect(r.discrepancies).toEqual([{ field: "premiumAmount", documentValue: "9200.00", databaseValue: "8500.00" }]);
  });
  it("does not flag a renewal that is the same day a year earlier (last term's document)", () => {
    expect(comparePolicyFacts({ renewalDate: "2025-12-01" }, db).discrepancies).toEqual([]);
    expect(comparePolicyFacts({ renewalDate: "2026-11-15" }, db).discrepancies).toHaveLength(1);
  });
});

describe("DocumentReconciliationService — flags, never overwrites", () => {
  const OCR = "Policy No: ABC123456789 Total Premium: Rs 9,200 Sum Insured: 1000000 Renewal Date: 01/12/2026";
  const build = (existing: Array<Record<string, unknown>> = [], docOver: Record<string, unknown> = {}) => {
    const client = {
      document: {
        findFirst: jest.fn().mockResolvedValue({ id: "d1", userId: "u1", entityType: "POLICY", entityId: "p1", ocrText: OCR, ...docOver }),
        update: jest.fn().mockResolvedValue({}),
      },
      insurancePolicy: {
        findFirst: jest.fn().mockResolvedValue({ id: "p1", premiumAmount: { toString: () => "8500.00" }, coverageAmount: { toString: () => "1000000.00" }, renewalDate: new Date("2026-12-01T00:00:00Z") }),
        update: jest.fn(),
      },
      documentDiscrepancy: {
        findMany: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return { client, svc: new DocumentReconciliationService({ client } as never) };
  };

  it("records a premium conflict as a discrepancy and never updates the policy", async () => {
    const { client, svc } = build();
    const r = await svc.reconcile("u1", "d1", 0.9);
    expect(r).toMatchObject({ supported: true, created: 1 });
    expect(client.documentDiscrepancy.create.mock.calls[0][0].data).toMatchObject({ field: "premiumAmount", documentValue: "9200.00", databaseValue: "8500.00", entityId: "p1" });
    expect(client.insurancePolicy.update).not.toHaveBeenCalled();
    expect(client.document.update.mock.calls[0][0].data.extractionMetadata).toEqual({ extractor: "policy-v1", fieldsFound: ["premiumAmount", "coverageAmount", "renewalDate"], ocrConfidence: 0.9 });
  });

  it("stores no extracted values or identifiers in the extraction metadata", async () => {
    const { client, svc } = build();
    await svc.reconcile("u1", "d1");
    expect(JSON.stringify(client.document.update.mock.calls[0][0].data)).not.toMatch(/9200|ABC123|6789/);
  });

  it("is idempotent: an unchanged existing discrepancy is not duplicated", async () => {
    const { client, svc } = build([{ id: "x1", field: "premiumAmount", documentValue: "9200.00", databaseValue: "8500.00", status: "OPEN" }]);
    const r = await svc.reconcile("u1", "d1");
    expect(r).toMatchObject({ created: 0, updated: 0 });
    expect(client.documentDiscrepancy.create).not.toHaveBeenCalled();
  });

  it("does not reopen a discrepancy the user already resolved when nothing changed", async () => {
    const { client, svc } = build([{ id: "x1", field: "premiumAmount", documentValue: "9200.00", databaseValue: "8500.00", status: "KEPT_DATABASE" }]);
    await svc.reconcile("u1", "d1");
    expect(client.documentDiscrepancy.update).not.toHaveBeenCalled();
  });

  it("closes an OPEN discrepancy once the database value was corrected to match the document", async () => {
    const { client, svc } = build([{ id: "x1", field: "premiumAmount", documentValue: "8500.00", databaseValue: "7000.00", status: "OPEN" }], { ocrText: "Total Premium: Rs 8,500" });
    const r = await svc.reconcile("u1", "d1");
    expect(r.closed).toBe(1);
    expect(client.documentDiscrepancy.update.mock.calls[0][0].data.status).toBe("RESOLVED");
  });

  it("is a no-op for unlinked, non-policy or text-less documents, and 404s on someone else's document", async () => {
    expect((await build([], { entityType: null }).svc.reconcile("u1", "d1")).supported).toBe(false);
    expect((await build([], { ocrText: null }).svc.reconcile("u1", "d1")).supported).toBe(false);
    const other = build();
    other.client.document.findFirst.mockResolvedValue(null);
    await expect(other.svc.reconcile("u2", "d1")).rejects.toBeInstanceOf(NotFoundException);
    expect(other.client.document.findFirst).toHaveBeenCalledWith({ where: { id: "d1", userId: "u2" } });
  });

  it("resolving is ownership- and state-scoped and offers no way to edit the record", async () => {
    const { client, svc } = build();
    await svc.resolve("u1", "x1", "KEEP_DATABASE");
    expect(client.documentDiscrepancy.updateMany).toHaveBeenCalledWith({ where: { id: "x1", userId: "u1", status: "OPEN" }, data: expect.objectContaining({ status: "KEPT_DATABASE" }) });
    client.documentDiscrepancy.updateMany.mockResolvedValue({ count: 0 });
    await expect(svc.resolve("u2", "x1", "DISMISS")).rejects.toBeInstanceOf(NotFoundException);
    expect(client.insurancePolicy.update).not.toHaveBeenCalled();
  });
});

describe("FINANCIAL_FACT RAG sources", () => {
  const input = {
    position: { netWorth: "140000.00", totalAssets: "140000.00", totalLiabilities: "0.00", cash: { available: "33000.00", emergency: "7000.00", total: "40000.00" }, investmentValue: "100000.00", property: "0.00", loans: "0.00" },
    cashFlow: { month: "2026-10", income: "65000.00", expenses: "15000.00", investmentContributions: "10000.00", emergencyAllocations: "7000.00" },
    emergency: { emergencyCash: "7000.00", coverageMonths: "0.47", avgMonthlyEssentialExpenses: "15000.00" },
    policies: [{ id: "p1", provider: "HDFC Ergo", type: "HEALTH", premiumAmount: "8500.00", premiumFrequency: "YEARLY", coverageAmount: "1000000.00", renewalDate: new Date("2026-12-01T00:00:00Z"), nomineeName: "Asha", policyNumber: "HEA12345678" }],
    investments: [{ id: "i1", name: "Axis Bluechip", type: "MUTUAL_FUND", currentValue: "100000.00", valuedAt: new Date("2026-10-01T00:00:00Z"), contributions: "90000.00", withdrawals: "0.00", sipActive: true, monthlyContribution: "10000.00" }],
    loans: [{ id: "l1", lender: "SBI", type: "HOME", outstandingPrincipal: "2500000.00", emiAmount: "24000.00", interestRateAnnual: "8.50" }],
    dataHealth: [{ code: "INVESTMENT_AS_EXPENSE", message: "SIP entries are recorded as expenses.", count: 1, amount: "10000.00" }],
  };
  const sources = buildFinancialFactSources(input, new Date("2026-10-04T00:00:00Z"));

  it("indexes a summary, emergency fund, each policy/investment/loan and data health", () => {
    expect(sources.map((s) => s.metadata.factType)).toEqual(["SUMMARY", "EMERGENCY_FUND", "POLICY", "INVESTMENT", "LOAN", "DATA_HEALTH"]);
    expect(sources.every((s) => s.sourceType === "FINANCIAL_FACT")).toBe(true);
  });
  it("tags record sources with entityType/entityId so documents can be related to them", () => {
    expect(sources.find((s) => s.sourceId === "POLICY:p1")?.metadata).toMatchObject({ entityType: "POLICY", entityId: "p1" });
  });
  it("keeps the authoritative figures and the cash split in the text", () => {
    const summary = sources[0].text;
    expect(summary).toContain("₹33,000");
    expect(summary).toContain("₹7,000");
    expect(summary).toContain("₹40,000");
  });
  it("masks the policy number, and nothing identifying survives redaction", () => {
    const policy = sources.find((s) => s.sourceId === "POLICY:p1")!.text;
    expect(policy).toContain("ending 5678");
    expect(policy).not.toContain("HEA12345678");
    expect(new RedactionService().redact(policy).text).not.toContain("HEA12345678");
  });
  it("states plainly when coverage can't be calculated instead of inventing it", () => {
    const s = buildFinancialFactSources({ ...input, emergency: { ...input.emergency, coverageMonths: null } }, new Date());
    expect(s[1].text).toMatch(/cannot be calculated/);
  });
});

describe("masking and document data-health detectors", () => {
  it("masks identifiers to their last four characters", () => {
    expect(maskIdentifier("HEA 1234-5678")).toBe("ending 5678");
    expect(maskIdentifier("1234")).toBe("****");
    expect(maskIdentifier(null)).toBe("not recorded");
  });
  it("flags only policy/loan/property/statement/tax documents that have no link", () => {
    const out = detectUnlinkedDocuments([
      { id: "a", category: "INSURANCE_POLICY", entityType: null },
      { id: "b", category: "INSURANCE_POLICY", entityType: "POLICY" },
      { id: "c", category: "RECEIPT", entityType: null },
      { id: "d", category: "AADHAAR", entityType: null },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: "UNLINKED_DOCUMENT", count: 1, entityIds: ["a"] });
  });
  it("raises a warning for open document discrepancies and nothing when there are none", () => {
    expect(detectDocumentDiscrepancies([{ id: "x" }])[0]).toMatchObject({ code: "DOCUMENT_DISCREPANCY", severity: "WARNING" });
    expect(detectDocumentDiscrepancies([])).toEqual([]);
  });
});
