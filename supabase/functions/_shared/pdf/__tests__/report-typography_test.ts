/**
 * Report typography guards.
 *
 * These exist because the PDF theme is shared by transactional documents
 * and analytical reports. The `document` profile IS the transactional
 * behaviour — if it ever drifts from `theme`, every invoice in the system
 * silently reformats. The report profiles carry the opposite guarantee:
 * their body type may never fall back to the old 7.5pt / 6pt-floor values.
 */

import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { theme } from "../themes/accountantMono.ts";
import {
  resolveTypography,
  inferPresentationProfile,
  type PresentationProfile,
} from "../themes/presentation.ts";
import { PDFDocument } from "https://esm.sh/pdf-lib@1.17.1";
import { generateReportPdf } from "../../reportPdfGenerator.ts";

Deno.test("document profile is byte-for-byte the legacy theme", () => {
  const t = resolveTypography("document");
  assertEquals(t.size, { ...theme.size });
  assertEquals(t.rowHeight, theme.rowHeight);
  assertEquals(t.pageMargin, theme.pageMargin);
  assertEquals(t.bottomMargin, theme.bottomMargin);
  assertEquals(t.tableHeaderHeight, theme.tableHeaderHeight);
  assertEquals(t.minNumericFontSize, 6);
});

Deno.test("an omitted / unknown profile falls back to document", () => {
  assertEquals(resolveTypography(undefined), resolveTypography("document"));
  assertEquals(
    resolveTypography("nonsense" as PresentationProfile),
    resolveTypography("document"),
  );
});

Deno.test("report profiles never render body text below 8.5pt", () => {
  for (const p of ["statement", "ledger", "operational"] as const) {
    const t = resolveTypography(p);
    assert(t.size.tableCell >= 8.5, `${p} body ${t.size.tableCell}`);
    assert(t.size.tableHeader >= 9, `${p} header ${t.size.tableHeader}`);
    assert(t.minNumericFontSize >= 7.5, `${p} floor ${t.minNumericFontSize}`);
    assert(t.rowHeight > theme.rowHeight, `${p} row height ${t.rowHeight}`);
    assert(t.size.pageNumber >= 8.5 && t.size.footerNote >= 8.5, `${p} chrome`);
  }
});

Deno.test("dense reports reclaim gutter instead of shrinking type", () => {
  const ledger = resolveTypography("ledger");
  const statement = resolveTypography("statement");
  assert(ledger.pageMargin < theme.pageMargin);
  // Statements are few-column and stay on the formal 1" statutory gutter.
  assertEquals(statement.pageMargin, theme.pageMargin);
  assert(statement.size.tableCell > ledger.size.tableCell);
});

Deno.test("profile inference: statutory → statement, wide → ledger", () => {
  assertEquals(inferPresentationProfile("financial", 3), "statement");
  // Wide "financial" reports are schedules, not statements — 10pt across
  // eight currency columns costs a page and buys no legibility.
  assertEquals(inferPresentationProfile("financial", 5), "statement");
  assertEquals(inferPresentationProfile("financial", 6), "ledger");
  assertEquals(inferPresentationProfile("financial", 12), "ledger");
  assertEquals(inferPresentationProfile("operational", 4), "operational");
  assertEquals(inferPresentationProfile("operational", 5), "operational");
  assertEquals(inferPresentationProfile("operational", 6), "ledger");
  assertEquals(inferPresentationProfile("operational", 7), "ledger");
  assertEquals(inferPresentationProfile(undefined, 9), "ledger");
});

// ── Rendered regression ────────────────────────────────────────────────

const LEDGER_COLUMNS = [
  { key: "date", header: "Date", width: 12 },
  { key: "ref", header: "Reference", width: 12 },
  { key: "desc", header: "Description", width: 28 },
  { key: "account", header: "Account", width: 20 },
  { key: "debit", header: "Debit", format: "currency", align: "right" as const },
  { key: "credit", header: "Credit", format: "currency", align: "right" as const },
  { key: "balance", header: "Balance", format: "currency", align: "right" as const },
];

const LEDGER_ROWS = Array.from({ length: 60 }, (_, i) => ({
  date: `2026-03-${(i % 28) + 1}`,
  ref: `JRN-${1000 + i}`,
  desc: "Payment received from Acme Distributors Limited",
  account: "1200 Accounts Receivable",
  debit: 1234567.89,
  credit: 0,
  balance: 9876543.21,
}));

Deno.test("omitting the profile keeps the pinned-document render unchanged", async () => {
  const base = {
    title: "Statutory Schedule",
    columns: LEDGER_COLUMNS,
    rows: LEDGER_ROWS.slice(0, 10),
    currency: "KES",
    orientation: "landscape" as const,
  };
  const implicit = await generateReportPdf({ ...base });
  const explicit = await generateReportPdf({ ...base, presentationProfile: "document" });
  // Only the generated timestamp can differ between two renders.
  assert(
    Math.abs(implicit.length - explicit.length) <= 4,
    `document default drifted: ${implicit.length} vs ${explicit.length}`,
  );
});

Deno.test("ledger profile does not blow up pagination", async () => {
  const base = {
    title: "General Ledger",
    columns: LEDGER_COLUMNS,
    rows: LEDGER_ROWS,
    currency: "KES",
    orientation: "landscape" as const,
  };
  const before = await generateReportPdf({ ...base, presentationProfile: "document" });
  const after = await generateReportPdf({ ...base, presentationProfile: "ledger" });
  const pages = async (bytes: Uint8Array) =>
    (await PDFDocument.load(bytes)).getPageCount();
  const pagesBefore = await pages(before);
  const pagesAfter = await pages(after);
  assert(pagesAfter > 0);
  assert(
    pagesAfter <= pagesBefore + 1,
    `ledger profile added too many pages: ${pagesBefore} → ${pagesAfter}`,
  );
});
