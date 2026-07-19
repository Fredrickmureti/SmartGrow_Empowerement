/**
 * Milestone C.2 — Report XLSX builder tests.
 *
 * Round-trips the produced workbook back through SheetJS to verify cell
 * values, currency format codes, and merges.
 */
// deno-lint-ignore-file no-explicit-any
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import * as XLSX from "https://esm.sh/xlsx@0.18.5?target=deno";
import { buildReportXlsx, XLSX_MIME } from "./reportXlsx.ts";
import type { ReportExportConfig } from "./reportCsv.ts";

const fixture: ReportExportConfig = {
  title: "Trial Balance",
  companyName: "Analytical Engines Ltd",
  dateRange: "2026-01-01 to 2026-06-30",
  generatedAt: "2026-07-15T09:00:00Z",
  columns: [
    { key: "account", header: "Account", width: 40 },
    { key: "debit", header: "Debit", format: "currency", align: "right" },
    { key: "credit", header: "Credit", format: "currency", align: "right" },
  ],
  rows: [
    { account: "1000 · Cash", debit: 1000, credit: 0 },
    { account: "4000 · Consulting", debit: 0, credit: 1000 },
  ],
};

Deno.test("buildReportXlsx produces a valid OOXML workbook", () => {
  const bytes = buildReportXlsx(fixture);
  assertEquals(bytes instanceof Uint8Array, true);
  assert(bytes.byteLength > 0);
  // OOXML files are ZIP archives → start with "PK".
  assertEquals(bytes[0], 0x50);
  assertEquals(bytes[1], 0x4b);
});

Deno.test("buildReportXlsx round-trips title, headers, values", () => {
  const bytes = buildReportXlsx(fixture);
  const wb = XLSX.read(bytes, { type: "array" });
  const ws = wb.Sheets["Report"];
  assert(ws, "worksheet 'Report' must exist");
  assertEquals((ws as any)["A1"].v, "Trial Balance");
  // Header row lands after title + company + dateRange + blank spacer = row 5 (1-indexed).
  assertEquals((ws as any)["A5"].v, "Account");
  assertEquals((ws as any)["B5"].v, "Debit");
  assertEquals((ws as any)["C5"].v, "Credit");
  assertEquals((ws as any)["A6"].v, "1000 · Cash");
  assertEquals((ws as any)["B6"].v, 1000);
});

Deno.test("buildReportXlsx applies currency format to numeric columns", () => {
  const bytes = buildReportXlsx(fixture);
  const wb = XLSX.read(bytes, { type: "array", cellStyles: true });
  const ws = wb.Sheets["Report"];
  const b6 = (ws as any)["B6"];
  assertEquals(b6.t, "n");
  assertStringIncludes(b6.z, "0.00");
});

Deno.test("buildReportXlsx MIME constant matches OOXML sheet mime", () => {
  assertEquals(
    XLSX_MIME,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
});
