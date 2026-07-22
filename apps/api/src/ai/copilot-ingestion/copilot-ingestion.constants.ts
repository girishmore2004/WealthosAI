// Deterministic prefixes/suffixes bank and card statements commonly prepend to a
// merchant string — stripped before anything is shown to a human or sent to the
// model for further cleanup. Real, testable regex rules, not a model guess for the
// part of "normalization" that's actually mechanical.
export const MERCHANT_NOISE_PATTERNS: RegExp[] = [
  /^POS\s+/i,
  /^UPI[-/]/i,
  /^NEFT[-/]/i,
  /^IMPS[-/]/i,
  /^ECOM\s+/i,
  /\s*\d{6,}$/, // trailing long numeric reference codes
  /\s*\*{2,}\d+$/, // trailing masked card suffix like **1234
];

// A candidate transaction is a likely EXACT duplicate of an existing expense if it
// matches on all three within these tolerances — same day, same merchant (case-
// insensitive), and amount within a tiny rounding tolerance (statement exports
// occasionally round paise differently).
export const EXACT_DUPLICATE_AMOUNT_TOLERANCE = 0.5; // ₹

// A candidate is a likely NEAR duplicate (flagged, lower confidence) if it falls
// within this wider date/amount window — e.g. a transaction posted a day or two later
// than it was authorized, common with card statements.
export const NEAR_DUPLICATE_DATE_TOLERANCE_DAYS = 2;
export const NEAR_DUPLICATE_AMOUNT_TOLERANCE_FRACTION = 0.01; // 1%

export const MIN_CONFIDENCE_FOR_AUTO_SUGGEST_CATEGORY = 0.5;
