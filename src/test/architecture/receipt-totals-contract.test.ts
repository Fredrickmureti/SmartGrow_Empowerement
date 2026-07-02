/**
 * Architecture guard — payment receipt totals must be derived from
 * the `items` array only.
 *
 * The historical bug:
 *   subtotal = displayAmount             (= sum of allocations OR payment.amount)
 *   total    = displayAmount + unapplied (= an INDEPENDENT figure added on top)
 *
 * Produced subtotal=300k, total=600k on a single 300k payment whose
 * legacy single-invoice link prevented the renderer from emitting a
 * matching "unapplied" line item.
 *
 * The new contract:
 *   subtotal = Σ items.line_total
 *   tax      = Σ items.tax_amount
 *   total    = subtotal + tax
 * No exception. Drift between Σ items and payment.amount is logged but
 * NEVER added to the rendered total.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  "supabase/functions/generate-document/index.ts",
  "utf8",
);

// Narrow the search to the fetchReceipt function body.
function extractFetchReceipt(): string {
  const start = SRC.indexOf("async function fetchReceipt(");
  expect(start).toBeGreaterThan(-1);
  // Next async function declaration ends our window.
  const tail = SRC.slice(start);
  const end = tail.indexOf("\nasync function ", 1);
  return end > -1 ? tail.slice(0, end) : tail;
}

describe("payment receipt totals contract", () => {
  const body = extractFetchReceipt();

  it("never adds `unapplied` to the rendered total", () => {
    // Forbidden shapes from the buggy era:
    expect(body).not.toMatch(/total:\s*displayAmount\s*\+\s*\(restrictToInvoiceId/);
    expect(body).not.toMatch(/total:\s*displayAmount\s*\+\s*unapplied/);
    expect(body).not.toMatch(/amount_paid:\s*displayAmount\s*\+\s*\(restrictToInvoiceId/);
  });

  it("derives subtotal/total from the items array", () => {
    expect(body).toMatch(/itemsSubtotal\s*=\s*items\.reduce/);
    expect(body).toMatch(/itemsTotal\s*=\s*itemsSubtotal\s*\+\s*itemsTax/);
    expect(body).toMatch(/subtotal:\s*itemsSubtotal/);
    expect(body).toMatch(/total:\s*itemsTotal/);
  });

  it("logs (does not silently inflate) when Σ items disagrees with payment.amount", () => {
    expect(body).toMatch(/receipt totals drift/);
    expect(body).toMatch(/rendering items-as-truth/);
  });
});
