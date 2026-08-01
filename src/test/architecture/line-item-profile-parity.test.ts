/**
 * Enterprise Document Presentation Architecture — line-item presentation guard.
 *
 * Invariants locked here:
 *  1. The line-item column profile module exists in exactly two byte-identical
 *     copies (browser + edge) — the runtimes cannot share a module graph, so
 *     parity is enforced instead of hoped for.
 *  2. The receipt layout registry is likewise mirrored without drift (modulo
 *     the Deno `.ts` import extension).
 *  3. No renderer defines its own line-item column list. Column selection is a
 *     document-definition decision, resolved only by `lineItemProfiles`.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveLineItemColumns,
  profileShowsAmounts,
} from "@/lib/documents/lineItemProfiles";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");
/** Deno requires explicit `.ts` extensions; that is the only allowed delta. */
const normalise = (s: string) => s.replace(/\.ts";/g, '";');

describe("line-item profile parity", () => {
  it("browser and edge copies of lineItemProfiles are identical", () => {
    const browser = read("src/lib/documents/lineItemProfiles.ts");
    const edge = read("supabase/functions/_shared/documents/lineItemProfiles.ts");
    expect(normalise(edge)).toBe(normalise(browser));
  });

  it("browser and edge copies of the receipt layout registry are identical", () => {
    const browser = read("src/lib/receipt/layouts/index.ts");
    const edge = read("supabase/functions/_shared/receipt/layouts/index.ts");
    expect(normalise(edge)).toBe(normalise(browser));
  });
});

describe("renderers consume the shared profile", () => {
  it("the A4 PDF line-item table does not build its own column list", () => {
    const src = read("supabase/functions/_shared/pdf/components/LineItemsTable.ts");
    expect(src).toContain("resolveLineItemColumns");
    // The old hand-rolled column literals must be gone.
    expect(src).not.toContain('header: "Description", weight');
    expect(src).not.toContain('key: "disc"');
    expect(src).not.toContain('key: "price"');
  });

  it("the A4 coordinate table refuses narrow media instead of re-implementing it", () => {
    // ADR-0085: thermal documents go through the canonical Line[] engine +
    // renderThermalPdf. The A4 coordinate renderer must not host a second
    // narrow line-item implementation.
    const src = read("supabase/functions/_shared/pdf/components/LineItemsTable.ts");
    expect(src).not.toContain("drawLineItemsNarrow");
    expect(src).toMatch(/narrow|thermal/i);
  });

});

describe("profile semantics", () => {
  it("defaults to the accountant grid on A4", () => {
    const keys = resolveLineItemColumns({}, "a4").map((c) => c.key);
    expect(keys).toEqual(["index", "description", "qty", "unit_price", "amount"]);
  });

  it("collapses to description + amount on thermal", () => {
    const keys = resolveLineItemColumns({}, "thermal").map((c) => c.key);
    expect(keys).toEqual(["description", "qty", "amount"]);
  });

  it("hideAmounts suppresses every monetary column on both media", () => {
    expect(profileShowsAmounts({ hideAmounts: true }, "a4")).toBe(false);
    expect(profileShowsAmounts({ hideAmounts: true }, "thermal")).toBe(false);
  });

  it("tax and discount are opt-in and never appear when amounts are hidden", () => {
    const keys = resolveLineItemColumns(
      { showTax: true, showDiscount: true, hideAmounts: true },
      "a4",
    ).map((c) => c.key);
    expect(keys).not.toContain("tax");
    expect(keys).not.toContain("discount");
  });

  it("description is always present and is the flexible column", () => {
    for (const media of ["a4", "letter", "thermal", "label", "email_html"] as const) {
      const cols = resolveLineItemColumns({ showSku: true }, media);
      const desc = cols.find((c) => c.key === "description");
      expect(desc, media).toBeDefined();
      expect(desc!.cells).toBeNull();
    }
  });
});
