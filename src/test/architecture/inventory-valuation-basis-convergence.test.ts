/**
 * Phase 6b guard — one authoritative inventory valuation basis.
 *
 * After Phase 6 the cost-layer ledger (`_inventory_layer_valuation_as_of`) owns
 * inventory VALUE. Every helper that reports a value must read it. Anything
 * still derived from `warehouse_stock.average_cost` / `products.cost_price` must
 * be explicitly named and documented as an AVCO estimate or a divergence check
 * — never presented as an accounting valuation.
 *
 * Each assertion encodes a defect that was found and fixed:
 *  - the subledger composition "defended" the subledger figure on the AVCO
 *    basis, so its lines could not sum to the number it explained;
 *  - negative stock reported an AVCO amount as "valuation impact";
 *  - the opening-inventory backfill posted a product-cost estimate with no
 *    reference to the drift the reconciliation actually measures.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function latestMigrationDefining(fn: string): { file: string; sql: string } {
  const dir = join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(dir, f), "utf8").includes(`FUNCTION public.${fn}`));
  expect(hits.length, `no migration defines public.${fn}`).toBeGreaterThan(0);
  const file = hits[hits.length - 1]!;
  return { file, sql: readFileSync(join(dir, file), "utf8") };
}

/** Body of a single CREATE OR REPLACE FUNCTION block within a migration. */
function functionBody(sql: string, fn: string): string {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  expect(start, `public.${fn} not found in migration`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE ", start + 10);
  return sql.slice(start, next === -1 ? sql.length : next);
}

describe("inventory value derivations converge on the layer helper", () => {
  it("subledger composition is built from the shared layer helper", () => {
    const { sql } = latestMigrationDefining("list_inventory_subledger_composition");
    const body = functionBody(sql, "list_inventory_subledger_composition");

    expect(body).toContain("_inventory_layer_valuation_as_of");
    // The old AVCO expression must be gone from the composition entirely.
    expect(body).not.toMatch(/average_cost/);
    expect(body).not.toMatch(/cost_price/);
  });

  it("composition keeps the reconciliation's authorization contract", () => {
    const body = functionBody(
      latestMigrationDefining("list_inventory_subledger_composition").sql,
      "list_inventory_subledger_composition",
    );

    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path TO 'public'");
    expect(body).toContain("_assert_org_member");
    expect(body).toContain("_assert_inventory_report_access");
    expect(body).toContain("INVENTORY_RECON_BUSINESS_REQUIRED");
  });

  it("composition EXECUTE is revoked from PUBLIC and anon", () => {
    const { sql } = latestMigrationDefining("list_inventory_subledger_composition");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.list_inventory_subledger_composition[^;]*FROM PUBLIC, anon/,
    );
  });

  it("unlayered positions are flagged, never estimated into the total", () => {
    const body = functionBody(
      latestMigrationDefining("list_inventory_subledger_composition").sql,
      "list_inventory_subledger_composition",
    );
    expect(body).toContain("'unlayered'");
  });

  it("negative-stock exposure is named as an AVCO estimate", () => {
    const { sql } = latestMigrationDefining("list_negative_stock_positions");
    const body = functionBody(sql, "list_negative_stock_positions");

    expect(body).toContain("avco_unit_cost");
    expect(body).toContain("avco_exposure_estimate");
    // The misleading "valuation impact" naming must not come back.
    expect(body).not.toContain("valuation_impact");
    // Findings view uses the same honest naming.
    expect(sql).toContain("'avco_exposure_estimate'");
    expect(sql).not.toContain("'valuation_impact'");
  });

  it("negative-stock listing is company-scoped like the reconciliation", () => {
    const body = functionBody(
      latestMigrationDefining("list_negative_stock_positions").sql,
      "list_negative_stock_positions",
    );
    expect(body).toContain("INVENTORY_RECON_BUSINESS_REQUIRED");
    expect(body).toContain("_assert_inventory_report_access");
  });

  it("opening backfill declares its basis and is capped by measured drift", () => {
    const body = functionBody(
      latestMigrationDefining("backfill_opening_inventory_gl").sql,
      "backfill_opening_inventory_gl",
    );

    expect(body).toContain("'product_cost_estimate'");
    expect(body).toContain("reconcile_inventory_subledger_to_gl");
    expect(body).toContain("no_layer_basis_drift");
    expect(body).toContain("LEAST(v_total, v_layer_drift)");
  });

  it("the client types the layer-derived bases, not AVCO ones", () => {
    const hook = read("src/hooks/finance/useInventoryReconciliation.ts");

    expect(hook).toContain("cost_layer");
    expect(hook).toContain("unlayered");
    expect(hook).toContain("avco_exposure_estimate");
    expect(hook).not.toContain('"avco" | "product_cost" | "none"');
    expect(hook).not.toContain("valuation_impact");
    // The composition drill-down must be pinned to the same as-at date.
    expect(hook).toContain("p_as_of: asOf ?? null");
  });

  it("the reconciliation card labels bases and never says 'valuation impact'", () => {
    const card = read("src/components/finance/InventoryReconciliationCard.tsx");

    expect(card).toContain("COST_BASIS_LABEL");
    expect(card).toContain("AVCO exposure (est.)");
    expect(card).not.toContain("Valuation impact");
    expect(card).toContain("useInventorySubledgerComposition(showComposition, asOf)");
  });

  it("the AVCO-vs-layer divergence check stays explicitly labelled", () => {
    const quants = read("src/hooks/inventory/useStockQuants.ts");
    // This one MAY read AVCO — that is what it measures — but it must say so.
    expect(quants).toContain("avco_vs_layers");
    expect(quants).toContain("AVCO valuation");
  });

  it("the SQL ratchet asserts composition ties to the subledger figure", () => {
    const ratchet = read("supabase/tests/inventory_reporting_ratchet_test.sql");
    expect(ratchet).toContain("list_inventory_subledger_composition");
    expect(ratchet).toContain("COMPOSITION FAIL");
    expect(ratchet).toContain("an AVCO / product-cost basis survives in the composition");
  });
});
