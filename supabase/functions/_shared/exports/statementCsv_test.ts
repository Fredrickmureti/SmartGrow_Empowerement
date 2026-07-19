/**
 * Milestone C.1 — CSV builder architecture test.
 *
 * Verifies the RFC 4180 shape: UTF-8 BOM, CRLF separators, correct
 * escaping of commas/quotes inside cells, and that both the transactions
 * and aging sections land in the output.
 */
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { buildStatementCsv } from "./statementCsv.ts";

const fixture = {
  document_number: "Statement - Ada, Inc.",
  document_type: "customer_statement",
  document_type_label: "CUSTOMER STATEMENT",
  status: "sent",
  issue_date: "2026-07-01",
  subtotal: 0,
  tax_amount: 0,
  discount_amount: 0,
  total: 1250,
  amount_paid: 750,
  currency: "USD",
  contact: { name: 'Ada, "The" Byron' },
  organization: { id: "biz", name: "Analytical Engines Ltd" },
  items: [],
  statement_transactions: [
    { date: "2026-06-05", type: "Invoice", reference: "INV-1", description: "Invoice INV-1", charges: 1000, credits: 0, balance: 1000 },
    { date: "2026-06-20", type: "Payment", reference: "R-9", description: 'Payment received (R-9)', charges: 0, credits: 250, balance: 750 },
  ],
  statement_aging: [
    { label: "Current", amount: 500 },
    { label: "1-30 Days", amount: 250 },
  ],
  statement_opening_balance: 0,
  statement_closing_balance: 1250,
  statement_period_start: "2026-06-01",
  statement_period_end: "2026-06-30",
} as any;

Deno.test("buildStatementCsv emits BOM + CRLF", () => {
  const bytes = buildStatementCsv(fixture);
  // `ignoreBOM: true` — the default TextDecoder strips U+FEFF; keep it so
  // we can assert the byte-level prefix Excel needs for UTF-8 detection.
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  assert(text.startsWith("\uFEFF"), "must start with UTF-8 BOM for Excel");
  assert(text.includes("\r\n"), "must use CRLF separators");
});

Deno.test("buildStatementCsv escapes quotes and commas per RFC 4180", () => {
  const bytes = buildStatementCsv(fixture);
  const text = new TextDecoder().decode(bytes);
  // Contact name contains a comma AND embedded quotes.
  assertStringIncludes(text, `"Ada, ""The"" Byron"`);
});

Deno.test("buildStatementCsv contains transactions and aging sections", () => {
  const bytes = buildStatementCsv(fixture);
  const text = new TextDecoder().decode(bytes);
  assertStringIncludes(text, "Date,Type,Reference,Description,Charges,Credits,Balance");
  assertStringIncludes(text, "INV-1");
  assertStringIncludes(text, "Aging bucket,Amount");
  assertStringIncludes(text, "Current,500");
});

Deno.test("buildStatementCsv returns Uint8Array", () => {
  const bytes = buildStatementCsv(fixture);
  assertEquals(bytes instanceof Uint8Array, true);
  assert(bytes.byteLength > 0);
});
