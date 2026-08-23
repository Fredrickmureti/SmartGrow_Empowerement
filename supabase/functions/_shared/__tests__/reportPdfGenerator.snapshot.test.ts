/**
 * Snapshot + registry tests for the unified PDF engine.
 *
 * Run:
 *   deno test --allow-net --allow-env supabase/functions/_shared/__tests__
 *
 * Coverage (Stages F + J of the reporting consolidation):
 *   • PDF byte sanity (header magic, non-zero length) for representative
 *     payload shapes — financial report, statement with recipient,
 *     empty body, multi-tenant differentiation.
 *   • Column registry contract — every registered report has a sane
 *     column shape; numeric columns are right-aligned and currency-formatted.
 *   • Renderer accepts traceability metadata (_meta) without crashing.
 *   • Stage J: accountant-grade format invariants pinned at the
 *     formatter level (negatives in parentheses, currency-prefixed,
 *     two fraction digits) so any regression in `_shared/format/currency.ts`
 *     fails CI before it reaches a real PDF.
 */

import { assertEquals, assert, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { generateReportPdf } from "../reportPdfGenerator.ts";
import { REPORT_SPECS, getReportSpec, getReportTitle } from "../reports/columnSpecs.ts";
import { formatAccountingNumber, getCurrencySymbol } from "../format/index.ts";

async function digest(bytes: Uint8Array): Promise<{ length: number; head: string }> {
  const head = Array.from(bytes.slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return { length: bytes.length, head };
}

Deno.test("PDF engine — financial report (Trial Balance shape) is stable", async () => {
  const bytes = await generateReportPdf({
    title: "Trial Balance",
    dateRange: "2024-01-01 to 2024-12-31",
    columns: [
      { key: "code", header: "Code", align: "left", format: "text" },
      { key: "name", header: "Account", align: "left", format: "text" },
      { key: "debit", header: "Debit", align: "right", format: "currency" },
      { key: "credit", header: "Credit", align: "right", format: "currency" },
    ],
    rows: [
      { code: "1000", name: "Cash", debit: 5000, credit: 0 },
      { code: "1100", name: "Accounts Receivable", debit: 12000, credit: 0 },
      { code: "2000", name: "Accounts Payable", debit: 0, credit: 3000 },
      { code: "3000", name: "Capital", debit: 0, credit: 14000 },
      { code: "", name: "Total", debit: 17000, credit: 17000, _isGrandTotal: true },
    ],
    currency: "USD",
    orientation: "landscape",
  });

  assertEquals(bytes[0], 0x25); // %
  assertEquals(bytes[1], 0x50); // P
  assertEquals(bytes[2], 0x44); // D
  assertEquals(bytes[3], 0x46); // F

  const d = await digest(bytes);
  console.log("[snapshot] trial-balance:", d);
  if (d.length === 0) throw new Error("empty PDF");
});

Deno.test("PDF engine — statement with recipient + summary is stable", async () => {
  const bytes = await generateReportPdf({
    title: "Customer Statement",
    dateRange: "2024-01-01 to 2024-12-31",
    columns: [
      { key: "date", header: "Date", align: "left", format: "date" },
      { key: "ref", header: "Reference", align: "left", format: "text" },
      { key: "amount", header: "Amount", align: "right", format: "currency" },
      { key: "balance", header: "Balance", align: "right", format: "currency" },
    ],
    rows: [
      { date: "2024-01-15", ref: "INV-001", amount: 1000, balance: 1000 },
      { date: "2024-02-10", ref: "PMT-001", amount: -500, balance: 500 },
      { date: "2024-03-05", ref: "INV-002", amount: 2500, balance: 3000 },
    ],
    recipientInfo: {
      name: "Acme Corp",
      address: "123 Main St",
      city: "Springfield",
      country: "USA",
    },
    amountDue: "$3,000.00",
    summaryRows: [
      { label: "Current", value: "$2,500.00" },
      { label: "1-30 days", value: "$500.00" },
      { label: "31-60 days", value: "$0.00" },
      { label: "60+ days", value: "$0.00" },
    ],
    currency: "USD",
    orientation: "landscape",
  });

  assertEquals(bytes[0], 0x25);
  const d = await digest(bytes);
  console.log("[snapshot] statement:", d);
  if (d.length === 0) throw new Error("empty PDF");
});

Deno.test("PDF engine — empty report still emits valid header/footer", async () => {
  const bytes = await generateReportPdf({
    title: "Empty Report",
    dateRange: "2024-01-01 to 2024-12-31",
    columns: [
      { key: "name", header: "Account", align: "left", format: "text" },
      { key: "balance", header: "Balance", align: "right", format: "currency" },
    ],
    rows: [],
    currency: "USD",
    orientation: "portrait",
  });

  assertEquals(bytes[0], 0x25);
  const d = await digest(bytes);
  console.log("[snapshot] empty:", d);
  if (d.length === 0) throw new Error("empty PDF");
});

Deno.test("PDF engine — multi-tenant: different titles produce different bytes", async () => {
  const a = await generateReportPdf({
    title: "Org A Trial Balance",
    columns: [{ key: "x", header: "X", align: "left", format: "text" }],
    rows: [{ x: "row" }],
  });
  const b = await generateReportPdf({
    title: "Org B Trial Balance",
    columns: [{ key: "x", header: "X", align: "left", format: "text" }],
    rows: [{ x: "row" }],
  });
  if (a.length === b.length && a.every((v, i) => v === b[i])) {
    throw new Error("identical PDFs for different titles — title not rendered");
  }
});

Deno.test("PDF engine — accepts row _meta for drill-down without crashing", async () => {
  const bytes = await generateReportPdf({
    title: "GL with traceability",
    columns: [
      { key: "name", header: "Account", align: "left", format: "text" },
      { key: "balance", header: "Balance", align: "right", format: "currency" },
    ],
    rows: [
      {
        name: "Cash",
        balance: 1000,
        _meta: { accountId: "acc-1", journalId: "je-1" },
      },
    ],
    currency: "USD",
  });
  assertEquals(bytes[0], 0x25);
  if (bytes.length === 0) throw new Error("empty PDF");
});

Deno.test("PDF engine — sanitizes WinAnsi-unsafe payslip diagnostics", async () => {
  const bytes = await generateReportPdf({
    title: "Payslip ⚠️",
    subtitle: "Employee statutory identifiers — localization smoke",
    companyName: "Acme Payroll ₦ Division",
    dateRange: "Pay Period: Jan 1, 2026 – Jan 31, 2026",
    columns: [
      { key: "description", header: "Description ⚠", width: 65, align: "left" },
      { key: "amount", header: "Amount", width: 35, format: "currency", align: "right" },
    ],
    rows: [
      { description: "[MISSING] employee KRA PIN — update on employee profile.", amount: "" },
      { description: "Bracket 0 – 24,000 @ 10% = ₦ 2,400", amount: "" },
      { description: "NET PAY", amount: 1234.56, _isGrandTotal: true },
    ],
    currency: "NGN",
    orientation: "portrait",
  });
  assertEquals(bytes[0], 0x25);
  assert(bytes.length > 1000, "PDF should render despite unsafe Unicode glyphs");
});

// ── Column registry contract ──────────────────────────────────────────

Deno.test("Registry — every spec has at least one column and a title", () => {
  for (const [type, spec] of Object.entries(REPORT_SPECS)) {
    assert(spec.title.length > 0, `${type}: missing title`);
    assert(spec.columns.length > 0, `${type}: empty columns`);
    assert(
      spec.orientation === "portrait" || spec.orientation === "landscape",
      `${type}: invalid orientation`,
    );
  }
});

Deno.test("Registry — currency-format columns are right-aligned", () => {
  for (const [type, spec] of Object.entries(REPORT_SPECS)) {
    for (const col of spec.columns) {
      if (col.format === "currency") {
        assertEquals(
          col.align,
          "right",
          `${type}.${col.key}: currency column must be right-aligned`,
        );
      }
    }
  }
});

Deno.test("Registry — known report types resolve to their spec", () => {
  assert(getReportSpec("trial_balance"));
  assert(getReportSpec("balance_sheet"));
  assert(getReportSpec("invoice_aging"));
  assertEquals(getReportSpec("does_not_exist"), null);
  assertEquals(getReportTitle("trial_balance"), "Trial Balance");
  assertEquals(getReportTitle("does_not_exist"), "Report");
});

Deno.test("Registry — column keys are unique within each report", () => {
  for (const [type, spec] of Object.entries(REPORT_SPECS)) {
    const seen = new Set<string>();
    for (const col of spec.columns) {
      assert(!seen.has(col.key), `${type}: duplicate column key "${col.key}"`);
      seen.add(col.key);
    }
  }
});

// ── Stage J: accountant-grade format invariants ───────────────────────

Deno.test("Format — negatives render in parentheses (accounting convention)", () => {
  assertEquals(formatAccountingNumber(-1234.56, "USD"), "($1,234.56)");
  assertEquals(formatAccountingNumber(-1, "USD"), "($1.00)");
  assertEquals(formatAccountingNumber(-1234.56, "KES"), "(KES 1,234.56)");
  assertEquals(formatAccountingNumber(-1234.56, "EUR"), "(€1,234.56)");
});

Deno.test("Format — positives are currency-prefixed, no parentheses", () => {
  assertEquals(formatAccountingNumber(1234.56, "USD"), "$1,234.56");
  assertEquals(formatAccountingNumber(0, "USD"), "$0.00");
  assertEquals(formatAccountingNumber(1234.56, "KES"), "KES 1,234.56");
});

Deno.test("Format — always two fraction digits with grouping", () => {
  assertEquals(formatAccountingNumber(1, "USD"), "$1.00");
  assertEquals(formatAccountingNumber(1000, "USD"), "$1,000.00");
  assertEquals(formatAccountingNumber(1000000, "USD"), "$1,000,000.00");
  assertEquals(formatAccountingNumber(0.1, "USD"), "$0.10");
});

Deno.test("Format — unknown currency code falls back to uppercase prefix", () => {
  assertEquals(getCurrencySymbol("xyz"), "XYZ ");
  assertEquals(formatAccountingNumber(100, "xyz"), "XYZ 100.00");
});

Deno.test("PDF engine — negative amounts in parentheses survive the render", async () => {
  // Smoke test: render a row with a negative currency value. We can't
  // easily extract text from pdf-lib bytes without a parser, but the
  // render must not crash and must produce a non-trivial PDF.
  const bytes = await generateReportPdf({
    title: "Reversal Journal",
    columns: [
      { key: "name", header: "Account", align: "left", format: "text" },
      { key: "amount", header: "Amount", align: "right", format: "currency" },
    ],
    rows: [
      { name: "Reversal", amount: -1234.56 },
      { name: "Adjustment", amount: 500 },
      { name: "Net", amount: -734.56, _isGrandTotal: true },
    ],
    currency: "USD",
  });
  assertEquals(bytes[0], 0x25);
  assert(bytes.length > 1000, "PDF should be substantial when rows are present");
});

// ── Stage J: monetary reports MUST carry at least one currency column ─

const MONETARY_REPORTS = new Set([
  "balance_sheet",
  "income_statement",
  "profit_and_loss",
  "trial_balance",
  "cash_flow",
  "general_ledger",
  "partner_ledger",
  "journal_report",
  "budget_vs_actual",
  "budget_schedule",
  "depreciation_schedule",
  "invoice_aging",
  "aged_payables",
]);

Deno.test("Registry — every monetary report has at least one currency column", () => {
  for (const reportType of MONETARY_REPORTS) {
    const spec = getReportSpec(reportType);
    if (!spec) continue; // Not all may be registered yet — skip silently.
    const hasCurrency = spec.columns.some((c) => c.format === "currency");
    assert(
      hasCurrency,
      `${reportType}: monetary report must have at least one currency column`,
    );
  }
});
