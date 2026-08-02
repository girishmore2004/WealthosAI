// Minimal CSV cell/row escaping shared by the Reports feature's hand-built CSV exports
// (monthlyReportCsv / yearlyReportCsv). There isn't enough tabular data anywhere in this
// app to justify pulling in a CSV library, but the previous implementation built every
// row via plain template-string interpolation (`${a},${b},${c}`), which silently
// corrupted the CSV column layout the moment a user-created Expense category name
// contained a comma, quote, or newline — all of which are legal category names.

const NEEDS_QUOTING = /[",\n\r]/;

export interface CsvCellOptions {
  // Defuses "CSV/formula injection": if a cell starting with =, +, -, @, tab, or CR is
  // opened directly in Excel/Google Sheets, the leading character can make the
  // spreadsheet app treat the cell as a formula. Only ever needed for cells built from
  // free-text user input (Expense category names) — never pass this for the report's
  // own numeric amounts, since a legitimately negative amount (e.g. "-4000.00" for a
  // net-cashflow row) also starts with "-" and must NOT be treated as a formula risk.
  neutralizeFormulas?: boolean;
}

export function csvCell(value: string | number, options: CsvCellOptions = {}): string {
  let str = String(value);

  if (options.neutralizeFormulas && /^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  if (NEEDS_QUOTING.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

export function csvRow(cells: string[]): string {
  return cells.join(",");
}
