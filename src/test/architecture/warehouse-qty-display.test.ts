/**
 * Architecture guard — no naked warehouse quantity renders (Warehouse
 * Product/Inventory Consumer Audit, Phase 2.4).
 *
 * A warehouse screen must never print a bare base-unit number. An operator who
 * received "10 Bags" and then reads `500` on a review grid is one keystroke from
 * a wrong count, and a supervisor cannot reconcile a variance of "-3" without
 * knowing whether that is 3 kg or 3 pallets.
 *
 * The rule: every product-scoped quantity renders through
 * `src/features/warehouse/quantity/warehouseQty.tsx` (which delegates to the
 * canonical `@/lib/inventory/formatQty` helpers); cross-product aggregates
 * render with an explicit unit word next to the figure.
 *
 * Regression this pins: a future edit reintroducing
 * `Number(row.quantity).toFixed(2)` into a warehouse surface.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOTS = ["src/pages/warehouse", "src/features/warehouse"] as const;

/** Surfaces whose figures are not product quantities (rates, money, geometry). */
const EXEMPT = [
  // Billing quantities are priced in the tariff's own UoM, printed alongside.
  "src/pages/warehouse/BillingBoard.tsx",
] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

/**
 * A naked product-quantity render: `.toFixed(...)` applied to something whose
 * accessor mentions quantity/qty, with no unit word anywhere in the expression.
 */
const NAKED = /\bNumber\(\s*[A-Za-z_$][\w$.?\[\]'" ]*(?:quantity|qty)[\w$.?\[\]'" ]*\s*(?:\?\?\s*0\s*)?\)\s*\.toFixed\(/gi;

describe("warehouse quantity display is unit-truthful", () => {
  const files = ROOTS.flatMap((r) => walk(resolve(process.cwd(), r))).filter(
    (f) => !EXEMPT.some((e) => f.endsWith(e.replace("src/", "src/"))),
  );

  it("scans a meaningful number of warehouse surfaces", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it("has no naked base-unit quantity renders", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const hits = src.match(NAKED);
      if (hits) offenders.push(`${file.split("/src/")[1]}: ${hits.join(" | ")}`);
    }
    expect(offenders, `Render these through WarehouseQty / useWarehouseQtyFormatter:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("keeps the canonical formatter as the only display seam", () => {
    const seam = readFileSync(
      resolve(process.cwd(), "src/features/warehouse/quantity/warehouseQty.tsx"),
      "utf8",
    );
    // The seam delegates; it must not do its own pack arithmetic.
    expect(seam).toContain("@/lib/inventory/formatQty");
    expect(seam).not.toMatch(/qty_in_base_uom\s*\*/);
  });
});
