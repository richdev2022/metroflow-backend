/**
 * Minimal RFC-4180 CSV serializer.
 *
 * VAPT MF-008: replaces the abandoned `xlsx` (SheetJS) package, which has
 * unfixable advisories (Prototype Pollution GHSA-4r6h-8v6p-xvw6, ReDoS
 * GHSA-5pgg-2g8v-p4x9 — "No fix available" on the npm registry). The ONLY
 * features the backend ever used were json_to_sheet + sheet_to_csv, i.e.
 * CSV export — which needs no dependency at all.
 */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (!Array.isArray(rows) || rows.length === 0) return "";

  // Preserve first-seen column order across all rows.
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row && typeof row === "object") {
      for (const key of Object.keys(row)) {
        if (!seen.has(key)) {
          seen.add(key);
          columns.push(key);
        }
      }
    }
  }

  const escapeCell = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    let str: string;
    if (value instanceof Date) str = value.toISOString();
    else if (typeof value === "object") str = JSON.stringify(value);
    else str = String(value);
    // Quote when the cell contains a delimiter, quote, newline — or when the
    // value could be interpreted as a formula in Excel (=, +, -, @ leading).
    if (/[",\r\n]/.test(str) || /^[=+\-@]/.test(str)) {
      // Guard against CSV formula injection ( spreadsheet gadget).
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines: string[] = [columns.map(escapeCell).join(",")];
  for (const row of rows) {
    lines.push(columns.map((col) => escapeCell(row?.[col])).join(","));
  }
  return lines.join("\r\n");
}
