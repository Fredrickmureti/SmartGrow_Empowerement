/**
 * Phase 7 guard — lot / serial traceability shares the ONE valuation basis and
 * the wave's security shape, and screen/export report the same columns.
 *
 * Each assertion pins a decision that would otherwise silently regress:
 *  - lot value must come from `_inventory_layer_valuation_as_of` (lot grain),
 *    never from a second lot-level layer aggregation;
 *  - the report RPC must assert org membership + inventory report access and
 *    must not be executable anonymously (the defect found on the pre-existing
 *    lot/serial trace RPCs);
 *  - depleted lots stay excluded by default so the value column ties to
 *    Inventory Valuation at the same date;
 *  - the page's column keys/order match the server column spec, so PDF/CSV/XLSX
 *    cannot drift from the screen.
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

function functionBody(sql: string, fn: string): string {
  const start = sql.indexOf(`FUNCTION public.${fn}(`);
  expect(start, `public.${fn} not found in migration`).toBeGreaterThan(-1);
  const next = sql.indexOf("CREATE OR REPLACE ", start + 10);
  return sql.slice(start, next === -1 ? sql.length : next);
}

const LOT_RPC = "report_lot_traceability_as_of";

describe("lot traceability reports on the shared layer valuation basis", () => {
  it("derives lot value from the shared helper, not new layer arithmetic", () => {
    const body = functionBody(latestMigrationDefining(LOT_RPC).sql, LOT_RPC);

    expect(body).toContain("_inventory_layer_valuation_as_of");
    // No second layer aggregation, and no AVCO / cost-price fallback.
    expect(body).not.toMatch(/cost_layer_consumptions/);
    expect(body).not.toMatch(/average_cost/);
    expect(body).not.toMatch(/cost_price/);
  });

  it("keeps the wave's authorization contract", () => {
    const { sql } = latestMigrationDefining(LOT_RPC);
    const body = functionBody(sql, LOT_RPC);

    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path");
    expect(body).toContain("_assert_org_member");
    expect(body).toContain("_assert_inventory_report_access");
    expect(body).toContain("INVENTORY_REPORT_BUSINESS_REQUIRED");
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${LOT_RPC}[^;]*FROM PUBLIC`));
    expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${LOT_RPC}[^;]*FROM anon`));
  });

  it("revokes anonymous execution on the lot/serial trace RPCs", () => {
    for (const fn of ["trace_lot_genealogy", "check_serial_position_drift"]) {
      const dir = join(ROOT, "supabase/migrations");
      const revoked = readdirSync(dir)
        .filter((f) => f.endsWith(".sql"))
        .some((f) => {
          const sql = readFileSync(join(dir, f), "utf8");
          return new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}[^;]*FROM anon`).test(sql);
        });
      expect(revoked, `public.${fn} still allows anon EXECUTE`).toBe(true);
    }
  });

  it("hides depleted lots by default so value ties to Inventory Valuation", () => {
    const body = functionBody(latestMigrationDefining(LOT_RPC).sql, LOT_RPC);
    expect(body).toMatch(/p_include_depleted\s+boolean\s+DEFAULT\s+false/i);
    expect(body).toContain("p_include_depleted OR a.qty_on_hand <> 0");
  });
});

describe("lot traceability screen and export share one dataset", () => {
  const spec = read("supabase/functions/_shared/reports/columnSpecs.ts");
  const page = read("src/pages/reports/LotTraceabilityReport.tsx");

  const specKeys = (() => {
    const start = spec.indexOf("lot_traceability: {");
    expect(start, "lot_traceability missing from columnSpecs").toBeGreaterThan(-1);
    const block = spec.slice(start, spec.indexOf("\n  },", start));
    return [...block.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]);
  })();

  const pageKeys = (() => {
    const start = page.indexOf("const columns = useMemo<ReportColumn[]>");
    expect(start, "column list missing from the page").toBeGreaterThan(-1);
    const block = page.slice(start, page.indexOf("], \n    [],", start) + 1 || start + 2000);
    return [...block.matchAll(/\{ key: "([^"]+)"/g)].map((m) => m[1]);
  })();

  it("column keys and order match between page and server spec", () => {
    expect(specKeys.length).toBeGreaterThan(10);
    expect(pageKeys.slice(0, specKeys.length)).toEqual(specKeys);
  });

  it("the export path is registered end to end", () => {
    const data = read("supabase/functions/_shared/reports/inventoryData.ts");
    expect(data).toContain('| "lot_traceability"');
    expect(data).toContain("report_lot_traceability_as_of");
    expect(read("supabase/functions/render-report/index.ts")).toContain('"lot_traceability"');
    expect(read("src/services/reports/ReportRegistry.ts")).toContain('reportType: "lot_traceability"');
    expect(read("src/apps/inventory/nav.ts")).toContain("/inventory-app/reports/lot-traceability");
  });

  it("the page performs no client-side valuation arithmetic", () => {
    expect(page).not.toMatch(/average_cost|cost_price/);
    expect(page).toContain("useLotTraceabilityAsOf");
  });
});
