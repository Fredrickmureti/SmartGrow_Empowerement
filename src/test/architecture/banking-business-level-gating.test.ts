/**
 * Phase 11 — Banking architecture guard.
 *
 * Bank accounts are business-level objects. Branches may own a bank account
 * (branch_id NOT NULL) or share a company-wide one (branch_id NULL), but
 * creating / editing / deleting a bank account requires the new
 * `finance.manage_bank_accounts` permission for the parent business.
 *
 * This test enforces that the Banking page + hook keep the canonical scope
 * primitives wired and that the new permission/RLS migration is shipped.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const listMigrations = () =>
  readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql"));

describe("Phase 11 — Banking is gated by finance.manage_bank_accounts", () => {
  it("useBankAccounts consumes useFinanceScope and the new permission", () => {
    const src = read("src/hooks/useBankAccounts.ts");
    expect(src).toMatch(/useFinanceScope/);
    expect(src).toMatch(/useFinancePermission\(["']finance\.manage_bank_accounts["']\)/);
  });

  it("useBankAccounts filters SELECT by branch_id when a branch is active", () => {
    const src = read("src/hooks/useBankAccounts.ts");
    expect(src).toMatch(/branch_id\.eq\.\$\{scope\.branchId\},branch_id\.is\.null/);
  });

  it("useBankAccounts stamps branch_id from the active scope on insert", () => {
    const src = read("src/hooks/useBankAccounts.ts");
    expect(src).toMatch(/branch_id\s*=\s*data\.branch_id\s*!==\s*undefined\s*\?\s*data\.branch_id\s*:\s*scope\.branchId/);
  });

  it("useBankAccounts maps the INSUFFICIENT_PRIVILEGE_BANK_MANAGE error to a friendly toast", () => {
    const src = read("src/hooks/useBankAccounts.ts");
    expect(src).toMatch(/INSUFFICIENT_PRIVILEGE_BANK_MANAGE/);
    expect(src).toMatch(/don't have permission to manage bank accounts/i);
  });

  it("Banking.tsx renders the scope badge, has no read-only banner, and gates Add on canManage", () => {
    const src = read("src/pages/Banking.tsx");
    expect(src).toMatch(/<FinanceScopeBadge\s*\/>/);
    // Bank accounts are branch-assignable (per FINANCE_SCOPE_MODEL.md);
    // branches own their own rows so the business-level read-only banner
    // must not appear here.
    expect(src).not.toMatch(/<BranchReadOnlyBanner/);
    expect(src).toMatch(/canManage\s*&&[\s\S]{0,200}?Add Bank Account/);
  });

  it("Total Balance tile prints the active scope label", () => {
    const src = read("src/pages/Banking.tsx");
    expect(src).toMatch(/scope\.scopeLabel/);
  });

  it("FinancePermission type includes finance.manage_bank_accounts", () => {
    const src = read("src/hooks/finance/useFinancePermission.ts");
    expect(src).toMatch(/"finance\.manage_bank_accounts"/);
  });

  it("Phase 11 migration ships the helper, permission key and *_perm_v3 RLS", () => {
    const matches = listMigrations();
    const found = matches
      .map((f) => read(`supabase/migrations/${f}`))
      .find(
        (sql) =>
          /assert_can_manage_bank_accounts/.test(sql) &&
          /finance\.manage_bank_accounts/.test(sql) &&
          /bank_accounts_insert_perm_v3/.test(sql) &&
          /bank_accounts_update_perm_v3/.test(sql) &&
          /bank_accounts_delete_perm_v3/.test(sql),
      );
    expect(found, "Phase 11 banking migration not found").toBeTruthy();
  });
});
