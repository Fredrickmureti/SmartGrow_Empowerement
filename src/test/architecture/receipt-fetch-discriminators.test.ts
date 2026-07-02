/**
 * Architecture guard: fetchReceipt in generate-document must keep all four
 * discriminators (id, invoice_id, invoice_allocation, receipt_number) so
 * bulk / multi-invoice payments stay resolvable when "View receipt" is
 * triggered against an invoice id. See .lovable/plan.md.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = readFileSync(
  resolve(__dirname, "../../../supabase/functions/generate-document/index.ts"),
  "utf8",
);

describe("fetchReceipt discriminators", () => {
  for (const disc of ["id", "invoice_id", "invoice_allocation", "receipt_number"]) {
    it(`includes "${disc}" in the tried list`, () => {
      expect(SRC).toContain(`tried.push("${disc}")`);
    });
  }

  it("queries payment_allocations by invoice_id", () => {
    expect(SRC).toMatch(/from\(["']payment_allocations["']\)[\s\S]{0,400}\.eq\(["']invoice_id["']/);
  });

  // Allocation-aware receipt fix: fetchReceipt MUST also load all
  // allocations for a resolved payment by `payment_id`, so multi-invoice
  // ("bulk") payments rendered from Sales → Payments stop printing
  // "Payment for Invoice N/A" and instead show a real per-invoice
  // breakdown. Regression guard.
  it("queries payment_allocations by payment_id", () => {
    expect(SRC).toMatch(/from\(["']payment_allocations["']\)[\s\S]{0,400}\.eq\(["']payment_id["']/);
  });

  it("emits payment_allocations onto DocumentData", () => {
    expect(SRC).toContain("payment_allocations: allocations");
  });

  it("does not emit literal 'Invoice N/A' in receipt items", () => {
    // The runtime template that produced the bug used `displayInvoiceNumber`
    // with a literal "N/A" fallback. Guard the actual code, not comments.
    expect(SRC).not.toMatch(/`[^`]*Invoice \$\{displayInvoiceNumber\}[^`]*`/);
    expect(SRC).not.toMatch(/displayInvoiceNumber\s*=\s*[\s\S]{0,200}\?\?\s*"N\/A"/);
  });

  // Regression: legacy single-invoice payments (no payment_allocations row
  // but payments.invoice_id set) must NOT be double-counted as both
  // "applied" AND "unapplied" — that produced the 300k → 600k receipt bug.
  it("zeroes 'unapplied' for legacy single-invoice payments", () => {
    expect(SRC).toContain("hasLegacyInvoiceLink");
    expect(SRC).toMatch(/restrictToInvoiceId\s*\|\|\s*hasLegacyInvoiceLink/);
  });
});
