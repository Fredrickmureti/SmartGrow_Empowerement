/**
 * CSV/Excel parser using the xlsx library for robust handling.
 * Supports: .csv, .xlsx, .xls, .txt
 */
import * as XLSX from "xlsx";
import type { ParsedStatement } from "./index";

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
  const nonEmptyRows = rawData.filter(row =>
    row.some(cell => String(cell).trim() !== "")
  );

  if (nonEmptyRows.length < 2) {
    throw new Error("File must contain at least a header row and one data row.");
  }

  const headers = nonEmptyRows[0].map(h => String(h).trim());
  const dataRows = nonEmptyRows.slice(1).map(row =>
    row.map(cell => String(cell ?? "").trim())
  );

  return {
    format: format === "excel" ? "excel" : "csv",
    transactions: [], // Will be populated after column mapping
    headers,
    rawRows: dataRows,
    needsColumnMapping: true,
  };
}
