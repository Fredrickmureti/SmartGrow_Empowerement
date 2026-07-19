/**
 * Milestone C.2 — Report CSV builder tests.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildReportCsv, type ReportExportConfig } from "./reportCsv.ts";

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
    { account: 'Consulting, "Ada" branch', debit: 0, credit: 1000 },
    { account: "Line\nwith newline", debit: 500, credit: 0 },
  ],
};

Deno.test("buildReportCsv emits BOM + CRLF", () => {
  const bytes = buildReportCsv(fixture);
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  assert(text.startsWith("\uFEFF"), "must start with UTF-8 BOM for Excel");
  assert(text.includes("\r\n"), "must use CRLF separators");
});

Deno.test("buildReportCsv escapes commas, quotes, and newlines per RFC 4180", () => {
  const bytes = buildReportCsv(fixture);
  const text = new TextDecoder().decode(bytes);
  assertStringIncludes(text, `"Consulting, ""Ada"" branch"`);
  assertStringIncludes(text, `"Line\nwith newline"`);
});

Deno.test("buildReportCsv includes title, company, dateRange, headers, footer", () => {
  const bytes = buildReportCsv(fixture);
  const text = new TextDecoder().decode(bytes);
  assertStringIncludes(text, "Trial Balance");
  assertStringIncludes(text, "Analytical Engines Ltd");
  assertStringIncludes(text, "2026-01-01 to 2026-06-30");
  assertStringIncludes(text, "Account,Debit,Credit");
  assertStringIncludes(text, "Generated: 2026-07-15T09:00:00Z");
});

Deno.test("buildReportCsv formats currency cells to two decimals", () => {
  const bytes = buildReportCsv(fixture);
  const text = new TextDecoder().decode(bytes);
  assertStringIncludes(text, "1000.00");
  assertStringIncludes(text, "500.00");
});

Deno.test("buildReportCsv returns a non-empty Uint8Array", () => {
  const bytes = buildReportCsv(fixture);
  assertEquals(bytes instanceof Uint8Array, true);
  assert(bytes.byteLength > 0);
});
