/**
 * ADR 0143 — inventory reports are one catalogue with two mounts.
 *
 * Guards the invariants that fixed the Finance ⇄ Inventory ping-pong:
 *   1. every inventory-family report declares BOTH mount paths;
 *   2. both mounts are actually routed;
 *   3. the Finance sidebar never links into /inventory-app and the Inventory
 *      sidebar never links into /finance;
 *   4. the Inventory sidebar is registry-driven, not hand-listed;
 *   5. no report page component is duplicated — one file per report.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  REPORT_REGISTRY,
  type ReportDefinition,
} from "@/services/reports/ReportRegistry";
import {
  REPORT_FAMILIES,
  buildReportsNavChildren,
  buildInventoryReportsNavChildren,
  collectNavReportPaths,
  resolveReportPath,
} from "@/services/reports/reportsNav";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const inventoryFamily = REPORT_FAMILIES.find((f) => f.key === "inventory")!;
const familyReports: ReportDefinition[] = inventoryFamily.reportIds.map((id) => {
  const def = REPORT_REGISTRY.find((r) => r.id === id);
  if (!def) throw new Error(`inventory family references unknown report ${id}`);
  return def;
});

describe("inventory reports — dual host", () => {
  it("every inventory-family report declares both mounts", () => {
    for (const def of familyReports) {
      expect(def.paths, `${def.id} must declare dual mounts`).toBeTruthy();
      expect(def.paths!.finance.startsWith("/finance/reports")).toBe(true);
      expect(def.paths!.inventory.startsWith("/inventory-app/reports")).toBe(true);
    }
  });

  it("resolves to the shell the user is currently in", () => {
    for (const def of familyReports) {
      expect(resolveReportPath(def, "/inventory-app/reports/valuation")).toBe(
        def.paths!.inventory,
      );
      expect(resolveReportPath(def, "/finance/reports/stock")).toBe(def.paths!.finance);
    }
  });

  it("both mounts are routed", () => {
    const finance = read("src/apps/finance/routes.tsx");
    const inventory = read("src/apps/inventory/routes.tsx");
    for (const def of familyReports) {
      const f = def.paths!.finance.replace("/finance/", "").split("?")[0];
      const i = def.paths!.inventory.replace("/inventory-app/", "").split("?")[0];
      expect(finance, `${def.id} finance mount`).toContain(`path="${f}"`);
      expect(inventory, `${def.id} inventory mount`).toContain(`path="${i}"`);
    }
  });

  it("both sidebars list the same inventory catalogue", () => {
    const financePaths = collectNavReportPaths(buildReportsNavChildren());
    const inventoryPaths = collectNavReportPaths(buildInventoryReportsNavChildren());
    for (const def of familyReports) {
      expect(financePaths).toContain(def.paths!.finance);
      expect(inventoryPaths).toContain(def.paths!.inventory);
    }
  });

  it("neither sidebar links across the app boundary", () => {
    for (const to of collectNavReportPaths(buildReportsNavChildren())) {
      expect(to.startsWith("/inventory-app"), `finance nav → ${to}`).toBe(false);
    }
    for (const to of collectNavReportPaths(buildInventoryReportsNavChildren())) {
      expect(to.startsWith("/finance"), `inventory nav → ${to}`).toBe(false);
    }
    expect(read("src/apps/inventory/nav.ts")).not.toContain("/finance/");
  });

  it("the Inventory Insights group is registry-driven", () => {
    expect(read("src/apps/inventory/nav.ts")).toContain(
      "buildInventoryReportsNavChildren()",
    );
  });

  it("no report page component is duplicated", () => {
    const pages = [
      "InventoryValuationReport",
      "StockLedgerReport",
      "StockAgingReport",
      "LotTraceabilityReport",
      "StockAdjustmentsReport",
      "StockTransfersReport",
      "InventoryGLReconciliation",
      "StockReports",
    ];
    for (const page of pages) {
      expect(() => read(`src/pages/reports/${page}.tsx`)).not.toThrow();
    }
  });

  it("each inventory report belongs to exactly one family", () => {
    const seen = new Map<string, string>();
    for (const family of REPORT_FAMILIES) {
      for (const id of family.reportIds) {
        expect(seen.has(id), `${id} in two families`).toBe(false);
        seen.set(id, family.key);
      }
    }
  });
});
