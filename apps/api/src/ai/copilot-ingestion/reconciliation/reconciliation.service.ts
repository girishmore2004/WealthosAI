import { Injectable } from "@nestjs/common";
import { LoansService } from "../../../loans/loans.service";
import { InvestmentsService } from "../../../investments/investments.service";
import {
  INVESTMENT_MERCHANT_KEYWORDS,
  LOAN_MERCHANT_KEYWORDS,
  RECONCILIATION_AMOUNT_TOLERANCE_FRACTION,
  RECONCILIATION_DATE_TOLERANCE_DAYS,
} from "../copilot-ingestion.constants";

export type TransactionKind = "EXPENSE" | "LOAN_EMI" | "INVESTMENT_CONTRIBUTION";

export interface LineClassification {
  transactionKind: TransactionKind;
  /** Set only for LOAN_EMI/INVESTMENT_CONTRIBUTION lines — null means "looks like an
   * EMI/contribution by merchant text, but couldn't be matched to a specific existing
   * Loan/Investment record" (still worth surfacing, see reconciliationNote). */
  matchedRecordId: string | null;
  reconciliationNote: string | null;
}

export interface ReconciliationFinding {
  type: "EMI_AMOUNT_MISMATCH" | "UNRECORDED_LOAN_PAYMENT" | "UNTRACKED_INVESTMENT_CONTRIBUTION" | "MISSING_EXPECTED_EMI";
  severity: "info" | "warning";
  message: string;
  loanId?: string;
  investmentId?: string;
  itemRawLine?: string;
}

export interface ReconciliationReport {
  findings: ReconciliationFinding[];
  loansChecked: number;
  investmentsChecked: number;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

// Deterministic, rule-based cross-referencing — no AI call, consistent with the rest
// of this feature's "AI narrowly, deterministic code everywhere else" design. Two
// distinct jobs, both explicitly asked for:
//   1. Per-line classification (classifyLine) — called once per parsed statement line
//      during ingest() to annotate IngestionReviewItem.transactionKind and flag amount
//      mismatches against an existing Loan the line's merchant/amount plausibly
//      matches. This never blocks or auto-edits anything — purely informational,
//      surfaced through the same review-queue confidence/rationale mechanism every
//      other signal in this feature already uses.
//   2. Batch-level reconciliation (reconcileBatch) — called on demand (GET
//      /copilot-ingestion/batches/:id/reconciliation) to find the opposite direction of
//      mismatch: an existing Loan whose expected EMI never showed up anywhere in this
//      statement/batch at all. Computed live rather than cached on the batch row,
//      because it depends on the user's current Loan/Investment records, which can
//      change after the batch was created — a cached reconciliation result would go
//      stale the moment the user edits a loan.
@Injectable()
export class ReconciliationService {
  constructor(
    private loans: LoansService,
    private investments: InvestmentsService,
  ) {}

  async classifyLine(
    userId: string,
    line: { merchantNormalized: string; amount: number; date: Date },
  ): Promise<LineClassification> {
    if (LOAN_MERCHANT_KEYWORDS.test(line.merchantNormalized)) {
      const loans = await this.loans.list(userId);
      const matched = this.matchLoan(loans, line);
      if (matched) {
        const expected = Number(matched.emiAmount);
        const diffFraction = expected === 0 ? 1 : Math.abs(expected - line.amount) / expected;
        const note =
          diffFraction > RECONCILIATION_AMOUNT_TOLERANCE_FRACTION
            ? `Statement shows ₹${line.amount.toFixed(2)} but the recorded EMI for this loan (${matched.lender}) is ₹${expected.toFixed(2)} — worth checking for a rate change or missed update.`
            : `Matches the recorded EMI for ${matched.lender}.`;
        return { transactionKind: "LOAN_EMI", matchedRecordId: matched.id, reconciliationNote: note };
      }
      return {
        transactionKind: "LOAN_EMI",
        matchedRecordId: null,
        reconciliationNote: "Looks like a loan/EMI payment, but no matching Loan record was found in your account — consider adding it under Loans.",
      };
    }

    if (INVESTMENT_MERCHANT_KEYWORDS.test(line.merchantNormalized)) {
      const investments = await this.investments.list(userId);
      const matched = this.matchInvestment(investments, line);
      if (matched) {
        return {
          transactionKind: "INVESTMENT_CONTRIBUTION",
          matchedRecordId: matched.id,
          reconciliationNote: `Matches an existing investment record (${matched.name}).`,
        };
      }
      return {
        transactionKind: "INVESTMENT_CONTRIBUTION",
        matchedRecordId: null,
        reconciliationNote: "Looks like an investment/SIP contribution, but no matching Investment record was found — consider adding it under Investments so your portfolio stays in sync.",
      };
    }

    return { transactionKind: "EXPENSE", matchedRecordId: null, reconciliationNote: null };
  }

  async reconcileBatch(
    userId: string,
    batchItems: { rawLine: string; merchantNormalized: string; parsedAmount: number; parsedDate: Date; status: string }[],
  ): Promise<ReconciliationReport> {
    const [loans, investments] = await Promise.all([this.loans.list(userId), this.investments.list(userId)]);
    const findings: ReconciliationFinding[] = [];

    const loanLines = batchItems.filter((i) => LOAN_MERCHANT_KEYWORDS.test(i.merchantNormalized));
    const investmentLines = batchItems.filter((i) => INVESTMENT_MERCHANT_KEYWORDS.test(i.merchantNormalized));

    for (const line of loanLines) {
      const matched = this.matchLoan(loans, { merchantNormalized: line.merchantNormalized, amount: line.parsedAmount, date: line.parsedDate });
      if (!matched) {
        findings.push({
          type: "UNRECORDED_LOAN_PAYMENT",
          severity: "warning",
          message: `"${line.rawLine}" looks like a loan/EMI payment not matched to any recorded Loan.`,
          itemRawLine: line.rawLine,
        });
        continue;
      }
      const expected = Number(matched.emiAmount);
      const diffFraction = expected === 0 ? 1 : Math.abs(expected - line.parsedAmount) / expected;
      if (diffFraction > RECONCILIATION_AMOUNT_TOLERANCE_FRACTION) {
        findings.push({
          type: "EMI_AMOUNT_MISMATCH",
          severity: "warning",
          message: `EMI for ${matched.lender} was ₹${line.parsedAmount.toFixed(2)} in this statement but ₹${expected.toFixed(2)} is recorded.`,
          loanId: matched.id,
          itemRawLine: line.rawLine,
        });
      }
    }

    for (const line of investmentLines) {
      const matched = this.matchInvestment(investments, { merchantNormalized: line.merchantNormalized, amount: line.parsedAmount, date: line.parsedDate });
      if (!matched) {
        findings.push({
          type: "UNTRACKED_INVESTMENT_CONTRIBUTION",
          severity: "info",
          message: `"${line.rawLine}" looks like an investment contribution not matched to any recorded Investment.`,
          itemRawLine: line.rawLine,
        });
      }
    }

    // Missing-entry direction: an active loan whose EMI never appears anywhere in this
    // batch at all, but the batch's date range plausibly spans a full statement cycle
    // (>= 25 days between earliest and latest parsed line — a short/partial-month
    // import wouldn't be expected to contain every loan's EMI, so this check is
    // skipped rather than producing a false "missing" flag for a short statement).
    if (batchItems.length > 0) {
      const dates = batchItems.map((i) => i.parsedDate.getTime());
      const spanDays = (Math.max(...dates) - Math.min(...dates)) / (1000 * 60 * 60 * 24);
      if (spanDays >= 25) {
        for (const loan of loans) {
          const hasMatch = loanLines.some((line) => this.matchLoan([loan], { merchantNormalized: line.merchantNormalized, amount: line.parsedAmount, date: line.parsedDate }));
          if (!hasMatch) {
            findings.push({
              type: "MISSING_EXPECTED_EMI",
              severity: "info",
              message: `No statement line matched the recorded EMI for ${loan.lender} (₹${Number(loan.emiAmount).toFixed(2)}) in this batch's date range.`,
              loanId: loan.id,
            });
          }
        }
      }
    }

    return { findings, loansChecked: loans.length, investmentsChecked: investments.length };
  }

  // Generic short words that would otherwise cause false-positive word-level matches
  // (e.g. every "X Bank" lender sharing the word "bank") — stripped before comparing.
  private static readonly GENERIC_NAME_WORDS = new Set(["bank", "ltd", "limited", "the", "of", "india", "and", "co"]);

  private significantWords(name: string): string[] {
    return name
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && !ReconciliationService.GENERIC_NAME_WORDS.has(w));
  }

  private matchLoan(
    loans: { id: string; lender: string; emiAmount: unknown }[],
    line: { merchantNormalized: string; amount: number; date: Date },
  ) {
    const merchantLower = line.merchantNormalized.toLowerCase();
    // Word-level match on the lender name first (e.g. merchant "HDFC EMI Payment" vs
    // lender "HDFC Bank" matches on the significant word "hdfc", ignoring the generic
    // word "bank") — deliberately NOT a whole-string substring match, since a
    // statement line essentially never repeats a lender's full registered name
    // verbatim. If no lender's significant words appear in the merchant text at all,
    // fall back to "the single loan whose EMI amount is within tolerance" — common for
    // statement lines that just say "EMI" or "LOAN PAYMENT" with no bank name. This
    // amount-based fallback intentionally only fires within tolerance: an amount that
    // already looks wrong shouldn't get pinned to a loan by amount alone (that's what
    // the name-based path above is for) — it should instead surface as unmatched, the
    // more honest signal to give a human.
    const byName = loans.find((l) => this.significantWords(l.lender).some((w) => merchantLower.includes(w)));
    if (byName) return byName;

    const byAmount = loans.filter((l) => {
      const expected = Number(l.emiAmount);
      const diffFraction = expected === 0 ? 1 : Math.abs(expected - line.amount) / expected;
      return diffFraction <= RECONCILIATION_AMOUNT_TOLERANCE_FRACTION;
    });
    return byAmount.length === 1 ? byAmount[0] : undefined;
  }

  private matchInvestment(
    investments: { id: string; name: string; purchaseDate: Date }[],
    line: { merchantNormalized: string; amount: number; date: Date },
  ) {
    const merchantLower = line.merchantNormalized.toLowerCase();
    return investments.find(
      (inv) =>
        this.significantWords(inv.name).some((w) => merchantLower.includes(w)) &&
        daysBetween(inv.purchaseDate, line.date) <= RECONCILIATION_DATE_TOLERANCE_DAYS,
    );
  }
}
