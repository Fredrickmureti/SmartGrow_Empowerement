/**
 * Architecture ratchet — Phase 8.
 *
 * The Stock Adjustments and Stock Transfers reports were browser-side
 * aggregations: they summed line snapshots for cost impact, never paged past
 * PostgREST's 1,000-row cap, and treated the company as an optional filter.
 * Each of those is an accounting defect, not a UI preference:
 *
 *  1. Cost impact must come from the posted movement ledger, not from
 *     `stock_adjustment_items.unit_cost` — a line snapshot is intent.
 *  2. A truncated read silently under-reports KPIs.
 *  3. A report that runs without a company scope leaks across the org.
 *
 * All three are fixed by owning the query in `report_stock_adjustments` /
 * `report_stock_transfers`. This test stops the pages from drifting back to
 * a direct table read.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGES = [
  "src/pages/reports/StockAdjustmentsReport.tsx",
  "src/pages/reports/StockTransfersReport.tsx",
];

const FORBIDDEN_TABLES = [
  "stock_adjustments",
  "stock_adjustment_items",
  "stock_transfers",
  "stock_transfer_items",
];

function read(file: string): string {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("stock operations reports are server-owned", () => {
  it("never query the adjustment / transfer tables from the browser", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      const src = read(page);
      for (const table of FORBIDDEN_TABLES) {
        if (src.includes(`from("${table}")`)) offenders.push(`${page} → ${table}`);
      }
    }
    expect(
      offenders,
      "These report pages read stock operation tables directly. Use " +
        "useStockAdjustmentsReport / useStockTransfersReport so cost impact " +
        "comes from the posted ledger and every row is paged.",
    ).toEqual([]);
  });

  it("consume the shared report hooks", () => {
    expect(read(PAGES[0])).toContain("useStockAdjustmentsReport");
    expect(read(PAGES[1])).toContain("useStockTransfersReport");
  });

  it("gate both reports on an active company, not just an organization", () => {
    const hooks = read("src/hooks/inventory/useInventoryReportRpcs.ts");
    const guards = hooks.match(/enabled: enabled && !!orgId && !!businessId,/g) ?? [];
    // valuation + ledger + traceability + the two new operations reports
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("distinguishes a posted ledger cost from an unposted estimate", () => {
    const src = read(PAGES[0]);
    expect(src).toContain("movement_ledger");
    expect(src).toContain("estimated_from_lines");
    // The posted KPI may only sum ledger-backed rows.
    expect(src).toMatch(/cost_basis === "movement_ledger"/);
  });
});
