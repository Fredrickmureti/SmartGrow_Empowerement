/**
 * Phase 5B guard — purchasing terms have one owner and one seam.
 *
 * 1. No client code may compute MOQ / order-increment arithmetic locally.
 *    That policy lives in `validate_supplier_order_quantity` on the server.
 * 2. The deprecated product-level defaults must not be read to make a
 *    purchasing decision outside the product master form (they are only the
 *    server resolver's fallback).
 * 3. The two purchasing RPCs have exactly one client caller each.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(process.cwd(), "src");
const SEAM = "src/features/products/purchasing/supplierPurchasingTerms.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).map((path) => ({
  rel: path.slice(process.cwd().length + 1).replace(/\\/g, "/"),
  body: readFileSync(path, "utf8"),
}));

const appFiles = files.filter(
  (f) =>
    !f.rel.startsWith("src/test/") &&
    !f.rel.includes(".test.") &&
    f.rel !== "src/integrations/supabase/types.ts",
);

describe("purchasing terms single owner", () => {
  it("has no browser-side MOQ validation hook", () => {
    const revived = appFiles.filter((f) => /\buseMOQValidation\b/.test(f.body));
    expect(revived.map((f) => f.rel)).toEqual([]);
  });

  it("resolves purchasing terms only through the seam", () => {
    // Only actual RPC invocations count; prose references in doc comments are fine.
    const CALL =
      /\.rpc\(\s*["'](?:resolve_supplier_purchasing_terms|validate_supplier_order_quantity|resolve_purchase_line_price)["']/;
    const callers = appFiles.filter(
      (f) => f.rel !== SEAM && CALL.test(f.body),
    );
    expect(callers.map((f) => f.rel)).toEqual([]);
  });

  it("keeps purchase price precedence on the server", () => {
    // No browser file may rank contract vs supplier price itself; the one
    // authority is `resolve_purchase_line_price`.
    const offenders = appFiles.filter(
      (f) =>
        f.rel !== SEAM &&
        /contract_unit_price\s*\?\?|contract_unit_price\s*\|\|/.test(f.body),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });



  it("does not read the deprecated product-level purchasing defaults to decide policy", () => {
    // Reading them to render/edit the product master is fine; comparing or
    // doing modulo arithmetic with them is the browser deciding policy.
    const COMPARISON =
      /(?:min_order_quantity|order_quantity_increment)\s*[<>]=?[^>]|[<>]=?\s*[\w.?[\]'"]*\b(?:min_order_quantity|order_quantity_increment)\b/;
    const MODULO =
      /%\s*\(?\s*[\w.?[\]'"]*\b(?:min_order_quantity|order_quantity_increment)\b/;
    const offenders = appFiles.filter(
      (f) => COMPARISON.test(f.body) || MODULO.test(f.body),
    );
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });


  // Phase 3 — the Purchases write surfaces must actually consult the terms.
  it("gates purchasing quantity entry on the server verdict", () => {
    const SURFACES = [
      "src/features/purchases/orders/PurchaseOrderCreatePage.tsx",
      "src/features/purchases/orders/PurchaseOrderEditPage.tsx",
      "src/features/purchases/requisitions/RequisitionCreatePage.tsx",
    ];
    const missing = SURFACES.filter((rel) => {
      const file = appFiles.find((f) => f.rel === rel);
      return (
        !file || !/validatePurchaseLinesAgainstTerms/.test(file.body)
      );
    });
    expect(missing).toEqual([]);
  });

  it("routes Purchases terms reads through the Purchases adapter", () => {
    const ADAPTER = "src/features/purchases/purchasingTerms/purchaseLineTerms.ts";
    const direct = appFiles.filter(
      (f) =>
        f.rel !== ADAPTER &&
        f.rel.startsWith("src/features/purchases/") &&
        /from "@\/features\/products\/purchasing\/supplierPurchasingTerms"/.test(
          f.body,
        ),
    );
    expect(direct.map((f) => f.rel)).toEqual([]);
  });
});
