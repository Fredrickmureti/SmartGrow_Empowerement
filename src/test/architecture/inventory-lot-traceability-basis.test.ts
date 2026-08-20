/**
 * Phase 7 guard — lot traceability must stay on the ONE valuation basis.
 *
 * The failure mode this pins: someone adds lot-level value by joining
 * cost_layers (or worse, live on-hand × products.cost_price) inside the lot
 * report, and the lot report silently stops agreeing with Inventory Valuation.
 * The only sanctioned source is the shared SQL helper
 * `_inventory_layer_valuation_as_of`, asked for at the lot grain.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

function migrationsContaining(needle: string): string[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => readFileSync(join(MIGRATIONS, f), "utf8").includes(needle));
}

function latestMigrationWith(needle: string): string {
  const files = migrationsContaining(needle).sort();
  expect(files.length, `no migration defines ${needle}`).toBeGreaterThan(0);
  return readFileSync(join(MIGRATIONS, files[files.length - 1]), "utf8");
}

describe("lot traceability RPC", () => {
  const sql = latestMigrationWith("report_lot_traceability_as_of");

  it("derives quantity and value only from the shared layer helper", () => {
    const body = sql.slice(sql.indexOf("report_lot_traceability_as_of"));
    expect(body).toContain("_inventory_layer_valuation_as_of(");
    // No second valuation basis inside the report.
    expect(body).not.toMatch(/FROM\s+public\.cost_layers/i);
    expect(body).not.toMatch(/cost_price/i);
    expect(body).not.toMatch(/warehouse_stock\.average_cost/i);
  });

  it("asserts org membership and business/branch report access", () => {
    const body = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.report_lot_traceability_as_of"));
    expect(body).toContain("_assert_org_member(p_org)");
    expect(body).toContain("_assert_inventory_report_access(p_business, p_branch)");
    expect(body).toContain("INVENTORY_REPORT_BUSINESS_REQUIRED");
  });

  it("is not callable anonymously", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.report_lot_traceability_as_of[\s\S]*?FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.report_lot_traceability_as_of[\s\S]*?TO authenticated, service_role;/);
  });

  it("keeps the lot grain optional on the shared helper so other reports are unchanged", () => {
    const helper = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public._inventory_layer_valuation_as_of"));
    expect(helper).toContain("p_by_lot    boolean DEFAULT false");
    expect(helper).toContain("p_lot       text DEFAULT NULL");
    expect(helper).toContain("_assert_inventory_report_access(p_business, p_branch)");
  });

  it("revokes anon execute on the trace RPCs (Phase 7.0)", () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.trace_lot_genealogy[\s\S]*?FROM PUBLIC, anon;/);
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.check_serial_position_drift[\s\S]*?FROM PUBLIC, anon;/);
  });
});

describe("lot traceability surfaces", () => {
  const page = readFileSync(
    join(process.cwd(), "src/pages/reports/LotTraceabilityReport.tsx"),
    "utf8",
  );
  const hook = readFileSync(
    join(process.cwd(), "src/hooks/inventory/useInventoryReportRpcs.ts"),
    "utf8",
  );
  const specs = readFileSync(
    join(process.cwd(), "supabase/functions/_shared/reports/columnSpecs.ts"),
    "utf8",
  );
  const data = readFileSync(
    join(process.cwd(), "supabase/functions/_shared/reports/inventoryData.ts"),
    "utf8",
  );

  it("reads the RPC through the shared hook, never a raw query", () => {
    expect(hook).toContain("report_lot_traceability_as_of");
    expect(page).toContain("useLotTraceabilityAsOf");
    expect(page).not.toContain("supabase");
  });

  it("exports through the server report registry, not a client-built table", () => {
    expect(page).toContain('reportType: "lot_traceability"');
    expect(specs).toContain("lot_traceability:");
    expect(data).toContain("report_lot_traceability_as_of");
  });

  it("screen and export share the same column keys in the same order", () => {
    const keys = (block: string) =>
      [...block.matchAll(/key: "([a-z_]+)"/g)].map((m) => m[1]);
    const specBlock = specs.slice(
      specs.indexOf("lot_traceability:"),
      specs.indexOf("inventory_aging:"),
    );
    const pageBlock = page.slice(
      page.indexOf("const columns = useMemo"),
      page.indexOf("const reportRows"),
    );
    expect(keys(pageBlock)).toEqual(keys(specBlock));
  });

  it("excludes depleted lots by default so value ties to Inventory Valuation", () => {
    expect(hook).toContain("p_include_depleted: filters.includeDepleted ?? false");
    expect(page).toContain("useState(false)");
  });
});
