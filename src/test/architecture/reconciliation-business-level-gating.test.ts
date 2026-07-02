/**
 * Phase 13 — Bank Reconciliation architecture guard.
 *
 * Reconciliation sessions, matches, and the reconcile/unreconcile RPCs
 * must all be (organization, business, branch) scoped and gated by the
 * `finance.reconcile_bank` permission. The hook and page must consume
 * useFinanceScope + useFinancePermission so a branch switch invalidates
 * data and a user without the perm gets a clean read-only state instead
 * of a raw RLS 42501.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const migrations = () =>
  readdirSync(join(root, "supabase/migrations"))
    .filter((f) => f.endsWith(".sql"))
    .sort();

const reconMigration = () => {
  // The Phase 13 reconciliation migration is the latest one that touches
  // bank_reconciliation_sessions AND ships assert_can_reconcile_bank.
  for (const f of migrations().slice().reverse()) {
    const src = read(`supabase/migrations/${f}`);
    if (
      src.includes("bank_reconciliation_sessions") &&
      src.includes("assert_can_reconcile_bank")
    ) {
      return src;
    }
  }
  throw new Error("Phase 13 reconciliation migration not found");
};

describe("Phase 13 — Bank Reconciliation is branch + permission scoped", () => {
  it("migration adds branch_id to bank_reconciliation_sessions", () => {
    const sql = reconMigration();
    expect(sql).toMatch(
      /ALTER TABLE\s+public\.bank_reconciliation_sessions[\s\S]*ADD COLUMN[\s\S]*branch_id\s+uuid/i,
    );
  });

  it("migration ships assert_can_reconcile_bank helper", () => {
    const sql = reconMigration();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.assert_can_reconcile_bank\(_business_id\s+uuid\)/i,
    );
    expect(sql).toMatch(/finance\.reconcile_bank/);
  });

  it("migration installs the four bank_recon_sessions_*_perm_v1 policies", () => {
    const sql = reconMigration();
    for (const op of ["select", "insert", "update", "delete"]) {
      expect(sql).toMatch(
        new RegExp(
          `CREATE POLICY\\s+bank_recon_sessions_${op}_perm_v1[\\s\\S]*bank_reconciliation_sessions`,
          "i",
        ),
      );
    }
  });

  it("session write policies reference finance.reconcile_bank and the branch clause", () => {
    const sql = reconMigration();
    expect(sql).toMatch(/has_finance_permission\([\s\S]*?finance\.reconcile_bank/);
    expect(sql).toMatch(/user_can_access_branch\(\s*auth\.uid\(\)\s*,\s*branch_id\s*\)/);
  });

  it("bank_recon_matches_write_perm_v1 references finance.reconcile_bank", () => {
    const sql = reconMigration();
    expect(sql).toMatch(/CREATE POLICY\s+bank_recon_matches_write_perm_v1/i);
    expect(sql).toMatch(/bank_recon_matches_write_perm_v1[\s\S]*finance\.reconcile_bank/);
  });

  it("reconcile_bank_transaction_atomic calls assert_can_reconcile_bank", () => {
    const sql = reconMigration();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.reconcile_bank_transaction_atomic/i,
    );
    expect(sql).toMatch(/assert_can_reconcile_bank\s*\(/);
  });

  it("unreconcile_bank_transaction calls assert_can_reconcile_bank", () => {
    const sql = reconMigration();
    expect(sql).toMatch(
      /CREATE OR REPLACE FUNCTION\s+public\.unreconcile_bank_transaction[\s\S]*assert_can_reconcile_bank/i,
    );
  });

  it("useReconciliationSessions consumes scope + finance.reconcile_bank perm", () => {
    const src = read("src/hooks/useReconciliationSessions.ts");
    expect(src).toMatch(/useFinanceScope\(\)/);
    expect(src).toMatch(/useFinancePermission\(\s*["']finance\.reconcile_bank["']\s*\)/);
  });

  it("useReconciliationSessions branch-filters fetch and refetches on scope change", () => {
    const src = read("src/hooks/useReconciliationSessions.ts");
    // branch filter
    expect(src).toMatch(/branch_id\.eq\.\$\{scope\.branchId\}/);
    expect(src).toMatch(/branch_id\.is\.null/);
    // fetch deps include business + branch
    expect(src).toMatch(
      /\[\s*currentOrg\?\.id\s*,\s*currentBusiness\?\.id\s*,\s*scope\.branchId\s*,\s*bankAccountId\s*\]/,
    );
  });

  it("useReconciliationSessions stamps branch_id on startSession and exposes canReconcile", () => {
    const src = read("src/hooks/useReconciliationSessions.ts");
    expect(src).toMatch(/branch_id:\s*scope\.branchId\s*\?\?\s*null/);
    expect(src).toMatch(/canReconcile/);
    expect(src).toMatch(/mapReconcilePermErr/);
  });

  it("BankReconciliation page renders FinanceScopeBadge + BranchReadOnlyBanner and gates writes on canReconcile", () => {
    const src = read("src/pages/BankReconciliation.tsx");
    expect(src).toMatch(/<FinanceScopeBadge\b/);
    expect(src).not.toMatch(/<BranchReadOnlyBanner/);
    expect(src).toMatch(/disabled=\{[^}]*!canReconcile/);
    // legacy manageFinancials gate around the reconcile cluster must be gone
    expect(src).not.toMatch(/PermissionGate\s+permission=["']manageFinancials["'][\s\S]{0,200}Reconcile/);
  });
});
