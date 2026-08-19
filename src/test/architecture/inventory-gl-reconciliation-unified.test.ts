/**
 * Phase 6 guard — Inventory ⇄ GL reconciliation must stay on ONE valuation
 * basis and ONE report engine.
 *
 * Each assertion encodes a defect that was found and fixed:
 *  - the subledger side used to be `warehouse_stock.quantity × AVCO`, so the
 *    reconciliation could disagree with the Inventory Valuation report for the
 *    same business and date and "drift" was not attributable to the GL;
 *  - the page exported a client-built `ExportConfig` while Phases 3–5 export
 *    server-built, so the same figure had two code paths;
 *  - the report existed only under Finance and was unreachable from the
 *    Inventory workspace.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

function latestMigrationDefining(fn: string): string {
  const dir = join(ROOT, "supabase/migrations");
  const hits = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) => readFileSync(join(dir, f), "utf8").includes(`FUNCTION public.${fn}`));
  expect(hits.length, `no migration defines public.${fn}`).toBeGreaterThan(0);
  return readFileSync(join(dir, hits[hits.length - 1]!), "utf8");
}

describe("inventory ⇄ GL reconciliation — single valuation basis", () => {
  it("valuation and reconciliation both read the shared layer helper", () => {
    const sql = latestMigrationDefining("reconcile_inventory_subledger_to_gl");

    expect(sql).toContain("_inventory_layer_valuation_as_of");
    // The valuation RPC must be re-based in the same migration so the two can
    // never drift apart again.
    expect(sql).toContain("FUNCTION public.report_inventory_valuation_as_of");
    expect(sql).toContain("FUNCTION public._inventory_layer_valuation_as_of");
  });

  it("the re-based reconciliation keeps the Phase 1 security shape", () => {
    const sql = latestMigrationDefining("reconcile_inventory_subledger_to_gl");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toMatch(/SET search_path\s+TO\s+'public'/i);
    expect(sql).toContain("_assert_org_member");
    expect(sql).toContain("_assert_inventory_report_access");
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.reconcile_inventory_subledger_to_gl/i);
  });

  it("the subledger side no longer values stock at live AVCO / cost_price", () => {
    const sql = latestMigrationDefining("reconcile_inventory_subledger_to_gl");
    const body = sql.slice(sql.indexOf("FUNCTION public.reconcile_inventory_subledger_to_gl"));
    expect(body).not.toMatch(/quantity\s*\*\s*COALESCE\(\s*NULLIF\(\s*\w+\.average_cost/i);
  });

  it("the GL side is summed from posted journal lines, never a cached balance", () => {
    const sql = latestMigrationDefining("reconcile_inventory_subledger_to_gl");
    const body = sql.slice(sql.indexOf("FUNCTION public.reconcile_inventory_subledger_to_gl"));
    expect(body).toContain("journal_entry_lines");
    expect(body).not.toContain("current_balance");
  });
});

describe("inventory ⇄ GL reconciliation — unified report engine", () => {
  const PAGE = "src/pages/reports/InventoryGLReconciliation.tsx";

  it("exports server-built through render-report", () => {
    const src = read(PAGE);
    expect(src).toContain("ServerBuildConfig");
    expect(src).toContain('reportType: "inventory_gl_reconciliation"');
    // No client-side row mapping into the export payload.
    expect(src).toMatch(/columns:\s*\[\]/);
    expect(src).toMatch(/rows:\s*\[\]/);
  });

  it("renders through the canonical report surface, not raw table markup", () => {
    const src = read(PAGE);
    expect(src).toContain('from "@/design-system/reports"');
    expect(src).toContain("<ReportTable");
    expect(src).toContain("<ReportSurface");
    expect(src).not.toMatch(/<TableHeader|<TableBody/);
  });

  it("registers the report key on the server so screen and export agree", () => {
    expect(read("supabase/functions/_shared/reports/columnSpecs.ts")).toContain(
      "inventory_gl_reconciliation:",
    );
    expect(read("supabase/functions/_shared/reports/inventoryData.ts")).toContain(
      'reportType === "inventory_gl_reconciliation"',
    );
    expect(read("supabase/functions/render-report/index.ts")).toContain(
      '"inventory_gl_reconciliation"',
    );
  });

  it("is reachable from the Inventory workspace via the single Finance route", () => {
    const nav = read("src/apps/inventory/nav.ts");
    expect(nav).toContain("/finance/reports/inventory-gl-reconciliation");
  });

  it("the hook types the layer-based exception counters", () => {
    const hook = read("src/hooks/finance/useInventoryReconciliation.ts");
    expect(hook).toContain("unlayered_positions");
    expect(hook).toContain("zero_cost_positions");
    expect(hook).toContain("negative_qty_positions");
    expect(hook).not.toContain("fallback_cost_lines");
  });
});
