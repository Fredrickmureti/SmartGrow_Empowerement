import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 8 — Fiscal Periods are a business-level construct. Branches must
 * see them but cannot mutate them without `finance.manage_periods`.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

describe("Fiscal Periods — business-level permission gate", () => {
  const page = read("src/pages/FiscalPeriods.tsx");

  it("page imports the canonical scope primitives", () => {
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(page).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(page).toMatch(/from\s+["']@\/components\/finance\/BranchReadOnlyBanner["']/);
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
  });

  it("page renders FinanceScopeBadge in the header", () => {
    expect(page).toMatch(/<FinanceScopeBadge\s*\/>/);
  });

  it("page renders BranchReadOnlyBanner with the periods permission label", () => {
    expect(page).toMatch(
      /<BranchReadOnlyBanner[^>]*area=["']Fiscal Periods["'][^>]*permissionLabel=["']finance\.manage_periods["']/,
    );
  });

  it("page calls useFinancePermission('finance.manage_periods') and gates mutators on canEditPeriods", () => {
    expect(page).toMatch(/useFinancePermission\(["']finance\.manage_periods["']\)/);
    expect(page).toMatch(/canManagePeriods/);
    // Canonical predicate: NON-HQ branch in a multi-branch business.
    expect(page).toMatch(/scope\.isBranchScopedReadOnly/);
    expect(page).toMatch(/canEditPeriods\s*=\s*canManagePeriods\s*&&\s*!insideBranchContext/);
    // Generate and Year-End buttons are wrapped in canEditPeriods.
    expect(page).toMatch(/canEditPeriods\s*&&\s*\(/);
    // Per-row Close/Reopen blocked when not canEditPeriods.
    expect(page).toMatch(/!canEditPeriods\s*\?[\s\S]*?Read-only/);
  });

  const sqlByFile = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const gateMig = sqlByFile.find(({ sql }) =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_manage_periods/i.test(sql),
  );

  it("assert_can_manage_periods helper migration exists", () => {
    expect(gateMig, "Phase 8 fiscal periods gate migration is missing").toBeDefined();
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_PERIOD_MANAGE/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(auth\.uid\(\),\s*'finance\.manage_periods'/);
  });

  it("fiscal_periods INSERT/UPDATE/DELETE policies require finance.manage_periods", () => {
    const sql = gateMig!.sql;
    expect(sql).toMatch(/CREATE\s+POLICY\s+fiscal_periods_insert_perm_v2[\s\S]*?finance\.manage_periods/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+fiscal_periods_update_perm_v2[\s\S]*?finance\.manage_periods/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+fiscal_periods_delete_perm_v2[\s\S]*?finance\.manage_periods/i);
  });
});
