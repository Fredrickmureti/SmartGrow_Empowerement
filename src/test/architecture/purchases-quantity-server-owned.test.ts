/**
 * Purchases Phase 1 — the base quantity is server-owned.
 *
 * Purchasing documents (requisition, RFQ, PO, goods receipt, bill, return)
 * send the supplier-facing quantity plus its packaging / UoM provenance.
 * The database trigger `_uom_normalize_line` converts that into the canonical
 * base quantity through `resolve_line_base_quantity`.
 *
 * No Purchases client file may multiply by a packaging factor to produce a
 * quantity it then persists. Preview arithmetic must go through the shared
 * helpers in `src/lib/inventory/uom.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { globSync } from "glob";

/** `something * qty_in_base_uom` / `* factor` style conversion in app code. */
const CONVERSION =
  /\*\s*[\w.?\[\]"'() ]*(qty_in_base_uom|qtyInBaseUom)\b/;

const PURCHASES_GLOBS = [
  "src/features/purchases/**/*.{ts,tsx}",
  "src/lib/purchases/**/*.{ts,tsx}",
  "src/hooks/usePurchaseOrders.ts",
  "src/hooks/usePurchaseReturns.ts",
  "src/hooks/useBills.ts",
  "src/hooks/useVendorCreditNotes.ts",
];

const isExempt = (file: string) =>
  file.includes("__tests__") || file.includes(".test.");

describe("Purchases: the browser never authors the base quantity", () => {
  const files = PURCHASES_GLOBS.flatMap((g) => globSync(g, { nodir: true })).filter(
    (f) => !isExempt(f),
  );

  it("finds Purchases source files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("no packaging-factor arithmetic in Purchases client code", () => {
    const offenders = files.filter((file) =>
      CONVERSION.test(readFileSync(file, "utf8")),
    );

    expect(
      offenders,
      `These Purchases files convert quantities in the browser. Send display_quantity + packaging_id/display_uom_id and let the server normalize:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
