/**
 * Guard: the customer statement is ONE engine.
 *
 * `src/services/finance/customerStatementDataset.ts` (screen + client PDF)
 * and `supabase/functions/_shared/reports/customerStatementDataset.ts`
 * (emailed / server-rendered PDF) must be byte-identical, and neither the
 * snapshot builder nor the edge fetcher may re-derive a statement from raw
 * `invoices` / `payments` / `credit_notes`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

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
