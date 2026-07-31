// Human-readable label/summary prefix per DocumentCategory. Shared between
// MockOcrAdapter and TesseractOcrAdapter so both describe a given category identically
// — previously this map lived only inside MockOcrAdapter and would have had to be
// copy-pasted (and kept in sync by hand) into any real adapter added later.
export const CATEGORY_SUMMARIES: Record<string, string> = {
  PAN: "PAN card on file for identity/tax verification.",
  AADHAAR: "Aadhaar card on file for identity verification.",
  SALARY_SLIP: "Salary slip — useful for income verification and loan applications.",
  FORM_16: "Form 16 — TDS certificate, needed for annual tax filing.",
  INSURANCE_POLICY: "Insurance policy document — check coverage terms and renewal date.",
  LOAN_DOCUMENT: "Loan agreement or statement.",
  MF_STATEMENT: "Mutual fund statement — cross-check holdings against the Investments tab.",
  TAX_RETURN: "Filed income tax return.",
  PROPERTY_PAPER: "Property ownership or registration document.",
  BUSINESS_DOCUMENT: "Business-related document.",
  RECEIPT: "Purchase or payment receipt.",
  BILL: "Utility or service bill.",
  OTHER: "Uncategorized document.",
};
