/**
 * Phase G architecture guard — Lot Genealogy & Traceability UI.
 *
 * ADR 0070 pins a read-only lot traceability surface backed by
 * existing tables. This guard makes sure the canonical traceability
 * query — business + product + lot_number against `stock_movements`
 * — is preserved. A refactor that drops any of the three predicates
 * (silently widening the timeline to the whole product, or across
 * businesses) fails CI here, not audit.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), rel), "utf8");

describe("Phase G — Lots list page", () => {
  const src = read("src/pages/inventory/Lots.tsx");

  it("reads from stock_lots scoped by organization + business", () => {
    expect(src).toMatch(/from\("stock_lots"\)/);
    expect(src).toMatch(/\.eq\("organization_id"/);
    expect(src).toMatch(/\.eq\("business_id"/);
  });

  it("navigates row clicks to /inventory-app/lots/:id", () => {
    expect(src).toMatch(/\/inventory-app\/lots\/\$\{[^}]+\}/);
  });
});

describe("Phase G — LotDetail page (traceability query is canonical)", () => {
  const src = read("src/pages/inventory/LotDetail.tsx");

  it("reads the lot header from stock_lots", () => {
    expect(src).toMatch(/from\("stock_lots"\)/);
  });

  it("reads the movement timeline from stock_movements", () => {
    expect(src).toMatch(/from\("stock_movements"\)/);
  });

  it("scopes the timeline by business_id + product_id + lot_number (all three required)", () => {
    expect(src).toMatch(/\.eq\("business_id"/);
    expect(src).toMatch(/\.eq\("product_id"/);
    expect(src).toMatch(/\.eq\("lot_number"/);
  });

  it("orders the timeline chronologically", () => {
    expect(src).toMatch(/\.order\("movement_date"/);
  });

  it("resolves reference_type for at least the core outbound documents", () => {
    // Regulator-facing labels must cover GRN + invoice + credit_note + delivery_note + transfer.
    for (const key of [
      "goods_receipt",
      "invoice",
      "credit_note",
      "delivery_note",
      "stock_transfer",
    ]) {
      expect(src).toMatch(new RegExp(`["']${key}["']`));
    }
  });
});

describe("Phase G — inventory router exposes lots surface", () => {
  const src = read("src/apps/inventory/routes.tsx");

  it("lazy-imports both pages", () => {
    expect(src).toMatch(/Lots\s*=\s*lazy\(/);
    expect(src).toMatch(/LotDetail\s*=\s*lazy\(/);
  });

  it("registers list + detail routes under lots", () => {
    expect(src).toMatch(/path="lots"/);
    expect(src).toMatch(/path="lots\/:id"/);
  });
});

describe("Phase G — inventory nav surfaces Lots & Traceability", () => {
  const src = read("src/apps/inventory/nav.ts");

  it("has a nav entry pointing at /inventory-app/lots", () => {
    expect(src).toMatch(/\/inventory-app\/lots/);
  });
});

describe("Phase G — ADR 0070 present", () => {
  it("ADR file exists", () => {
    const src = read("docs/adr/0070-lot-genealogy-traceability.md");
    expect(src).toMatch(/Lot Genealogy/i);
  });
});
