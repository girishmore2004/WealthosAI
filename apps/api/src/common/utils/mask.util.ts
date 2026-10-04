// Identifier masking for anything that is displayed, indexed or logged. Full policy / account
// numbers are never needed in free text — the last four characters are enough to tell two
// records apart.
export function maskIdentifier(value: string | null | undefined): string {
  const v = (value ?? "").replace(/[^A-Za-z0-9]/g, "");
  if (v.length === 0) return "not recorded";
  return v.length <= 4 ? "****" : `ending ${v.slice(-4)}`;
}
