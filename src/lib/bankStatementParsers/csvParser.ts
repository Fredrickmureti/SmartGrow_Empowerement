/**
 * CSV/Excel parser using the xlsx library for robust handling.
 * Supports: .csv, .xlsx, .xls, .txt
 *
 * Real bank exports start with preamble rows (bank name, account number,
 * currency, statement period) where only the first column is populated, and
 * `sheet_to_json` pads every row to the widest column. Taking "the first
 * non-empty row" as the header row therefore produced header labels that were
 * empty strings — which are not valid identifiers for the mapping UI.
 *
 * This parser detects the real header row and emits *column descriptors* with
 * a stable, non-empty, unique `key` instead of raw header strings.
 */
import * as XLSX from "xlsx";
import type { ParsedStatement, ParsedStatementColumn } from "./index";

const MAX_HEADER_SCAN_ROWS = 15;

function isNumericish(value: string): boolean {
  if (!value) return false;
  return /^[\s(]*[-+]?[0-9][0-9.,\s]*\)?$/.test(value);
}

function isDateish(value: string): boolean {
  if (!value) return false;
  return (
    /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(value) ||
    /^\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4}$/.test(value)
  );
}

/** A header cell is a label: non-empty, not a number, not a date. */
function looksLikeLabel(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (isNumericish(v)) return false;
  if (isDateish(v)) return false;
  return true;
}

/**
 * Pick the row that most plausibly holds the column headers.
 * Preamble rows populate one cell; the header row populates many label cells
 * and is followed by rows of comparable width.
 */
export function detectHeaderRowIndex(rows: string[][]): number {
  const limit = Math.min(rows.length - 1, MAX_HEADER_SCAN_ROWS);
  let bestIndex = 0;
  let bestScore = -1;

  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    const labelCells = row.filter((c) => looksLikeLabel(c)).length;
    if (labelCells < 2) continue;

    const next = rows[i + 1] ?? [];
    const nextFilled = next.filter((c) => String(c).trim() !== "").length;
    // Prefer a row followed by a data row of comparable width.
    const widthAgreement = nextFilled >= Math.ceil(labelCells / 2) ? 2 : 0;
    const score = labelCells + widthAgreement;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  return bestScore < 0 ? 0 : bestIndex;
}

function columnLetter(index: number): string {
  let n = index;
  let out = "";
  do {
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return out;
}

/**
 * Build non-empty, unique column keys. Columns that are blank in the header
 * AND empty in every data row are dropped entirely.
 */
export function buildColumns(
  headerRow: string[],
  dataRows: string[][],
): ParsedStatementColumn[] {
  const width = Math.max(
    headerRow.length,
    ...dataRows.map((r) => r.length),
    0,
  );

  const used = new Set<string>();
  const columns: ParsedStatementColumn[] = [];

  for (let index = 0; index < width; index++) {
    const label = String(headerRow[index] ?? "").trim();
    const values = dataRows.map((r) => String(r[index] ?? "").trim());
    const hasData = values.some((v) => v !== "");

    if (!label && !hasData) continue;

    const base = label || `Column ${columnLetter(index)}`;
    let key = base;
    let suffix = 2;
    while (used.has(key)) {
      key = `${base} (${suffix++})`;
    }
    used.add(key);

    columns.push({
      key,
      label: base,
      index,
      sample: values.find((v) => v !== "") ?? "",
    });
  }

  return columns;
}

export async function parseCSVOrExcel(
  file: File,
  format: "csv" | "excel"
): Promise<ParsedStatement> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dateNF: "yyyy-mm-dd" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rawData: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  // Filter out completely empty rows and trailing metadata
  const nonEmptyRows = rawData
    .filter((row) => row.some((cell) => String(cell).trim() !== ""))
    .map((row) => row.map((cell) => String(cell ?? "").trim()));

  if (nonEmptyRows.length < 2) {
    throw new Error("File must contain at least a header row and one data row.");
  }

  const headerIndex = detectHeaderRowIndex(nonEmptyRows);
  const headerRow = nonEmptyRows[headerIndex];
  const dataRows = nonEmptyRows.slice(headerIndex + 1);
  const preamble = nonEmptyRows.slice(0, headerIndex);

  const columns = buildColumns(headerRow, dataRows);

  return {
    format: format === "excel" ? "excel" : "csv",
    transactions: [], // Will be populated after column mapping
    columns,
    preamble,
    rawRows: dataRows,
    needsColumnMapping: true,
  };
}
