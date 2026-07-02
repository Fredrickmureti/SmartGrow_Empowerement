import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 6 — Chart of Accounts is a business-level entity. Branches must
 * see it but cannot mutate it without `finance.manage_coa` at business
 * scope. This test asserts the canonical wiring + the RLS gate.
 *
 * Failure modes guarded against:
 *   - Page silently lets a branch user edit/delete COA rows.
 *   - RLS write policies allow INSERT/UPDATE/DELETE on `accounts`
 *     without checking has_finance_permission('finance.manage_coa', ...).
 *   - `assert_can_manage_coa` helper goes missing (future RPCs depend on it).
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

describe("Chart of Accounts — business-level permission gate", () => {
  const accountsPage = read("src/pages/Accounts.tsx");

  it("page imports useFinanceScope, FinanceScopeBadge, BranchReadOnlyBanner, useFinancePermission", () => {
    expect(accountsPage).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(accountsPage).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(accountsPage).toMatch(/from\s+["']@\/components\/finance\/BranchReadOnlyBanner["']/);
    expect(accountsPage).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
  });

  it("page renders BranchReadOnlyBanner with the COA permission label", () => {
    expect(accountsPage).toMatch(
      /<BranchReadOnlyBanner[^>]*area=["']Chart of Accounts["'][^>]*permissionLabel=["']finance\.manage_coa["']/,
    );
  });

  it("page calls useFinancePermission('finance.manage_coa') and uses canEditCoa to gate mutators", () => {
    expect(accountsPage).toMatch(/useFinancePermission\(["']finance\.manage_coa["']\)/);
    expect(accountsPage).toMatch(/canManageCoa/);
    expect(accountsPage).toMatch(/canEditCoa\s*=\s*canManageCoa\s*&&\s*!isBranchReadOnly/);
    // Add Account / Import / Delete All must be wrapped in canEditCoa.
    expect(accountsPage).toMatch(/canEditCoa\s*&&[\s\S]{0,300}?Add Account/);
    expect(accountsPage).toMatch(/canEditCoa\s*&&[\s\S]{0,300}?Import/);
    expect(accountsPage).toMatch(/canEditCoa\s*&&[\s\S]{0,300}?Delete All/);
  });

  const sqlByFile = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const gateMig = sqlByFile.find(({ sql }) =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_manage_coa/i.test(sql),
  );

  it("assert_can_manage_coa helper migration exists", () => {
    expect(gateMig, "Phase 6 COA gate migration is missing").toBeDefined();
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_COA/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(auth\.uid\(\),\s*'finance\.manage_coa'/);
  });

  it("accounts INSERT/UPDATE/DELETE policies require finance.manage_coa", () => {
    const sql = gateMig!.sql;
    expect(sql).toMatch(/CREATE\s+POLICY\s+"accounts_insert_perm_v2"[\s\S]*?finance\.manage_coa/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+"accounts_update_perm_v2"[\s\S]*?finance\.manage_coa/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+"accounts_delete_perm_v2"[\s\S]*?finance\.manage_coa/i);
    // Delete still respects is_system protection.
    expect(sql).toMatch(/accounts_delete_perm_v2[\s\S]*?is_system\s*=\s*false/i);
  });

  it("accounts SELECT policy is NOT downgraded — branch users still read the COA", () => {
    // We deliberately did not drop accounts_select_perm; ensure no migration drops it
    // without replacement.
    const droppedSelect = sqlByFile.some(({ sql }) =>
      /DROP\s+POLICY\s+IF\s+EXISTS\s+["']accounts_select_perm["']\s+ON\s+public\.accounts/i.test(sql) &&
      !/CREATE\s+POLICY\s+["']accounts_select_perm/i.test(sql),
    );
    expect(droppedSelect).toBe(false);
  });
});
