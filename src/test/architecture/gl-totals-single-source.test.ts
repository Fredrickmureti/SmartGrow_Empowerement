/**
 * Brick 0 debt closure — one definition of "revenue and expenses for a period".
 *
 * `fetchGLTotals` feeds the finance dashboard, sales dashboard, executive stats,
 * GL intelligence and the cross-company comparative view. If it re-derives P&L in
 * JavaScript, those screens can disagree with the formal Profit & Loss statement.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const glTotals = readFileSync(join(root, "src/services/gl/fetchGLTotals.ts"), "utf8");
const comparative = readFileSync(join(root, "src/pages/reports/Consolidation.tsx"), "utf8");
const types = readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8");

describe("fetchGLTotals delegates to the ledger", () => {
  it("calls the server-side totals RPC", () => {
    expect(types).toContain("get_gl_pnl_totals");
    expect(glTotals).toContain('supabase.rpc("get_gl_pnl_totals"');
  });

  it("no longer classifies accounts or sums movements in the browser", () => {
    expect(glTotals).not.toContain('from("accounts")');
    expect(glTotals).not.toMatch(/account_type/);
    expect(glTotals).not.toMatch(/total_credit|total_debit/);
  });
});

describe("cross-company comparative authorization", () => {
  it("gates on the finance permission the database enforces, not an org role", () => {
    expect(comparative).toMatch(/useFinancePermission\(\s*"finance\.view_consolidated"/);
    expect(comparative).not.toMatch(/userRole\?\.role === "owner"/);
  });

  it("does not show a denial while the permission answer is still loading", () => {
    expect(comparative).toContain("if (!permLoading && !canViewConsolidation)");
  });
});
