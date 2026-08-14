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
    const revived = files.filter((f) => /useMOQValidation/.test(f.body));
    expect(revived.map((f) => f.rel)).toEqual([]);
  });

  it("resolves purchasing terms only through the seam", () => {
    const callers = appFiles.filter(
      (f) =>
        f.rel !== SEAM &&
        /resolve_supplier_purchasing_terms|validate_supplier_order_quantity/.test(
          f.body,
        ),
    );
    expect(callers.map((f) => f.rel)).toEqual([]);
  });

  it("does not read the deprecated product-level purchasing defaults to decide policy", () => {
    // Reading them to render/edit the product master is fine; using them in an
    // arithmetic comparison is the browser deciding purchasing policy.
    const offenders = appFiles.filter((f) => {
      if (!/min_order_quantity|order_quantity_increment/.test(f.body)) return false;
      return /(min_order_quantity|order_quantity_increment)\s*(\|\||\?\?)?[^;\n]*[<>]=?|%\s*\(?\s*(order_quantity_increment)/.test(
        f.body,
      );
    });
    expect(offenders.map((f) => f.rel)).toEqual([]);
  });
});
