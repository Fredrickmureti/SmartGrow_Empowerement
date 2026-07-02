import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 9 — Budgets are a business-level construct. Branches may own
 * branch-scoped budgets but mutating any budget requires the new
 * `finance.manage_budgets` permission.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

describe("Budgets — business-level permission gate", () => {
  const page = read("src/pages/Budgets.tsx");
  const hook = read("src/hooks/useBudgets.ts");

  it("page imports the canonical scope primitives", () => {
    expect(page).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
  });

  it("page renders FinanceScopeBadge and the budgets read-only banner", () => {
    expect(page).toMatch(/<FinanceScopeBadge\s*\/>/);
    expect(page).not.toMatch(/<BranchReadOnlyBanner/);
  });

  it("page gates Create / Edit / Activate / Close / Delete on canManageBudgets", () => {
    expect(page).toMatch(/useFinancePermission\(["']finance\.manage_budgets["']\)/);
    expect(page).toMatch(/canManageBudgets\s*&&\s*\(/);
  });

  it("hook keys budgets cache on the full finance scope", () => {
    expect(hook).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(hook).toMatch(/from\s+["']@\/lib\/finance\/financeKey["']/);
    expect(hook).toMatch(/financeKey\(scope,\s*["']budgets["']\)/);
  });

  it("hook stamps branch_id from active scope on insert", () => {
    expect(hook).toMatch(/branch_id:\s*scope\.branchId/);
  });

  const sqlByFile = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const gateMig = sqlByFile.find(({ sql }) =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_manage_budgets/i.test(sql),
  );

  it("assert_can_manage_budgets helper migration exists", () => {
    expect(gateMig, "Phase 9 budgets gate migration is missing").toBeDefined();
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_BUDGET_MANAGE/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(auth\.uid\(\),\s*'finance\.manage_budgets'/);
  });

  it("budgets INSERT/UPDATE/DELETE policies require finance.manage_budgets", () => {
    const sql = gateMig!.sql;
    expect(sql).toMatch(/CREATE\s+POLICY\s+budgets_insert_perm_v3[\s\S]*?finance\.manage_budgets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+budgets_update_perm_v3[\s\S]*?finance\.manage_budgets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+budgets_delete_perm_v3[\s\S]*?finance\.manage_budgets/i);
  });

  it("budget_items INSERT/UPDATE/DELETE policies require finance.manage_budgets", () => {
    const sql = gateMig!.sql;
    expect(sql).toMatch(/CREATE\s+POLICY\s+budget_items_insert_perm_v3[\s\S]*?finance\.manage_budgets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+budget_items_update_perm_v3[\s\S]*?finance\.manage_budgets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+budget_items_delete_perm_v3[\s\S]*?finance\.manage_budgets/i);
  });
});
