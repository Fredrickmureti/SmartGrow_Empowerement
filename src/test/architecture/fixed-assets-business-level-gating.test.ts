import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 10 — Fixed Assets are managed at the business level. Mutations
 * require the new `finance.manage_assets` permission. Asset-driven JEs
 * MUST stamp the asset's branch_id so depreciation/disposal entries
 * post under the same branch as the asset.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

describe("Fixed Assets — business-level permission gate", () => {
  const page = read("src/pages/FixedAssets.tsx");
  const hook = read("src/hooks/useFixedAssets.ts");
  const depRun = read("src/hooks/useDepreciationRun.ts");

  it("page imports the canonical scope primitives", () => {
    expect(page).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
  });

  it("page renders FinanceScopeBadge and the assets read-only banner", () => {
    expect(page).toMatch(/<FinanceScopeBadge\s*\/>/);
    expect(page).not.toMatch(/<BranchReadOnlyBanner/);
  });

  it("page gates Edit / Dispose / Delete / Run Depreciation on canManageAssets", () => {
    expect(page).toMatch(/useFinancePermission\(["']finance\.manage_assets["']\)/);
    expect(page).toMatch(/canManageAssets\s*&&/);
  });

  it("hook keys fixed-assets cache via financeKey and uses scope", () => {
    expect(hook).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(hook).toMatch(/from\s+["']@\/lib\/finance\/financeKey["']/);
    expect(hook).toMatch(/financeKey\(scope,\s*["']fixed-assets["']\)/);
  });

  it("hook stamps branch_id from active scope on asset insert", () => {
    expect(hook).toMatch(/branch_id:\s*stampedBranchId/);
  });

  it("acquisition goes through the server transaction; disposal JE carries the asset branch", () => {
    expect(hook).toMatch(/rpc\(\s*["']fa_create_asset["']/);
    expect(hook).toMatch(/branch_id:\s*asset\.branch_id\s*\?\?\s*null,/);
  });

  it("depreciation is server-authoritative: no client formula, no client JE", () => {
    expect(depRun).toMatch(/rpc\(\s*["']fa_depreciation_plan["']/);
    expect(depRun).toMatch(/rpc\(\s*["']fa_post_depreciation["']/);
    expect(depRun).not.toMatch(/postToGL\(|from\(["']journal_entr/);
    expect(depRun).not.toMatch(/from\(["']depreciation_schedules["']\)/);
  });

  const sqlByFile = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const gateMig = sqlByFile.find(({ sql }) =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_manage_assets/i.test(sql),
  );

  it("assert_can_manage_assets helper migration exists", () => {
    expect(gateMig, "Phase 10 fixed-assets gate migration is missing").toBeDefined();
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_ASSET_MANAGE/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(auth\.uid\(\),\s*'finance\.manage_assets'/);
  });

  it("fixed_assets / asset_categories / depreciation_schedules write policies require finance.manage_assets", () => {
    const sql = gateMig!.sql;
    expect(sql).toMatch(/CREATE\s+POLICY\s+fixed_assets_insert_perm_v3[\s\S]*?finance\.manage_assets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+fixed_assets_update_perm_v3[\s\S]*?finance\.manage_assets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+fixed_assets_delete_perm_v3[\s\S]*?finance\.manage_assets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+asset_categories_insert_perm_v3[\s\S]*?finance\.manage_assets/i);
    expect(sql).toMatch(/CREATE\s+POLICY\s+depreciation_schedules_insert_perm_v3[\s\S]*?finance\.manage_assets/i);
  });
});
