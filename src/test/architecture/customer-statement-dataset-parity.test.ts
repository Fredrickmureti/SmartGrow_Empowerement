/**
 * Guard: the statement is ONE engine — on both sides of the ledger.
 *
 * `src/services/finance/customerStatementDataset.ts` (screen + client PDF)
 * and `supabase/functions/_shared/reports/customerStatementDataset.ts`
 * (emailed / server-rendered PDF) must be byte-identical; the same holds for
 * the AP pair `vendorStatementDataset.ts` (modulo Deno's explicit `.ts`
 * import specifier). Neither the snapshot builders nor the edge fetchers may
 * re-derive a statement from raw documents.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
/** Deno needs the explicit extension; the app resolver must not have it. */
const normalizeSpecifiers = (src: string) =>
  src.replace(/from "(\.\/[A-Za-z0-9_/-]+)\.ts"/g, 'from "$1"');

describe("customer statement dataset", () => {
  it("app and edge copies of the builder are byte-identical", () => {
    expect(read("supabase/functions/_shared/reports/customerStatementDataset.ts")).toBe(
      read("src/services/finance/customerStatementDataset.ts"),
    );
  });

  it("the snapshot builder consumes the dataset, not raw documents", () => {
    const src = read("src/services/documents/snapshots/salesCustomerStatement.ts");
    expect(src).toContain("buildStatementDataset");
    expect(src).not.toMatch(/from\("invoices"\)|from\("payments"\)|from\("credit_notes"\)/);
  });

  it("the edge statement fetcher reads the AR subledger", () => {
    const src = read("supabase/functions/generate-document/index.ts");
    const fn = src.slice(
      src.indexOf("async function fetchCustomerStatement"),
      src.indexOf("// ── Legal Recipient Statement fetcher"),
    );
    expect(fn).toContain('from("customer_ledger_entries")');
    expect(fn).toContain("buildStatementDataset");
    expect(fn).not.toContain('from("invoices")');
    expect(fn).not.toContain('from("payments")');
    expect(fn).not.toContain('from("credit_notes")');
  });

  it("no statement path filters on the non-existent credit note status", () => {
    for (const f of [
      "src/services/documents/snapshots/salesCustomerStatement.ts",
      "supabase/functions/generate-document/index.ts",
      "src/hooks/useCustomerStatements.ts",
    ]) {
      // Prose may name the retired value; code may not use it.
      expect(read(f)).not.toMatch(/["']partially_applied["']/);

    }
  });

  it("statement aging is aged as of the period end, never the server clock", () => {
    const src = read("supabase/functions/generate-document/index.ts");
    const fn = src.slice(
      src.indexOf("async function fetchCustomerStatement"),
      src.indexOf("// ── Legal Recipient Statement fetcher"),
    );
    expect(fn).toContain('from("finance_ar_open_items")');
    expect(fn).not.toContain("new Date()");
  });
});

describe("vendor statement dataset", () => {
  const edgeVendorFetcher = () => {
    const src = read("supabase/functions/generate-document/index.ts");
    return src.slice(
      src.indexOf("async function fetchVendorStatement"),
      src.indexOf("// ── Inventory / Warehouse A4 voucher fetchers"),
    );
  };

  it("app and edge copies of the builder are identical", () => {
    expect(
      normalizeSpecifiers(read("supabase/functions/_shared/reports/vendorStatementDataset.ts")),
    ).toBe(normalizeSpecifiers(read("src/services/finance/vendorStatementDataset.ts")));
  });

  it("the AP builder reuses the AR accumulator rather than forking it", () => {
    const src = read("src/services/finance/vendorStatementDataset.ts");
    expect(src).toContain("buildStatementDataset");
  });

  it("the snapshot builder consumes the dataset, not raw documents", () => {
    const src = read("src/services/documents/snapshots/purchasesVendorStatement.ts");
    expect(src).toContain("buildVendorStatementDataset");
    expect(src).not.toMatch(
      /from\("bills"\)|from\("bill_payments"\)|from\("vendor_credit_notes"\)/,
    );
  });

  it("the screen hook folds the same shared dataset", () => {
    const src = read("src/hooks/useVendorStatements.ts");
    expect(src).toContain("fetchVendorLedgerRows");
    expect(src).toContain("buildVendorStatementDataset");
  });

  it("the edge vendor fetcher reads the AP subledger and ages at period end", () => {
    const fn = edgeVendorFetcher();
    expect(fn).toContain('from("vendor_ledger_entries")');
    expect(fn).toContain("buildVendorStatementDataset");
    expect(fn).toContain('from("finance_ap_open_items")');
    expect(fn).not.toContain('from("bills")');
    expect(fn).not.toContain('from("bill_payments")');
    expect(fn).not.toContain('from("vendor_credit_notes")');
    expect(fn).not.toContain("new Date()");
  });
});
