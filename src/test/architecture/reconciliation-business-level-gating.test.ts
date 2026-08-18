/**
 * Bank Reconciliation — scope + permission guard (Wave 3 rewrite).
 *
 * WHY THIS FILE CHANGED
 * The previous version grepped "the latest migration that mentions
 * bank_reconciliation_sessions AND assert_can_reconcile_bank". That is a
 * statement about migration authorship, not about the system: later waves
 * redefined the seams in newer migrations, so the ratchet went red while the
 * architecture it guards stayed correct. A ratchet that fails for a good
 * architecture teaches engineers to ignore ratchets.
 *
 * WHAT IT ASSERTS NOW — the properties, against the migration corpus as a
 * whole (the *final* definition of each object) and against the client:
 *
 *  1. `assert_can_reconcile_bank(business_id)` exists and is the one place the
 *     `finance.reconcile_bank` permission is decided.
 *  2. Every reconciliation write seam is gated by it — directly, or through
 *     `_bank_reconciliation_assert_account`, which performs the check.
 *  3. `bank_reconciliation_sessions` is branch-aware and its RLS names both
 *     the permission and the branch clause.
 *  4. The browser never stamps scope onto a session: it submits through the
 *     `bank_reconciliation_session_*` seams and consumes the permission for
 *     read-only UI, not for authorization.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Every migration, oldest first, concatenated. The last definition wins. */
const corpus = (() => {
  const dir = join(root, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8"))
    .join("\n\n");
})();

/**
 * The body of the LAST `CREATE OR REPLACE FUNCTION public.<name>` in the
 * corpus — i.e. the definition the database actually holds.
 */
function finalDefinition(name: string): string {
  const marker = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`,
    "gi",
  );
  let start = -1;
  for (const m of corpus.matchAll(marker)) start = m.index ?? start;
  if (start < 0) throw new Error(`No definition of public.${name} in migrations`);
  // A function body ends at the closing dollar-quote followed by a semicolon.
  const rest = corpus.slice(start);
  const end = rest.search(/\$\$\s*;/);
  return end < 0 ? rest : rest.slice(0, end + 3);
}

/** Seams whose caller is authorized directly by the helper. */
const DIRECTLY_GATED = [
  "assert_can_reconcile_bank",
  "bank_match_propose",
  "bank_match_confirm",
  "bank_match_reject",
  "bank_match_reverse",
  "unreconcile_bank_transaction",
  "bank_transaction_set_category",
  "bank_reconciliation_rule_upsert",
  "bank_reconciliation_rule_delete",
] as const;

/**
 * Seams that resolve their bank account through
 * `_bank_reconciliation_assert_account`, which performs the permission check
 * before returning the row. Gating there rather than in nine copies is the
 * point — one authority, not nine.
 */
const GATED_VIA_ACCOUNT_ASSERT = [
  "bank_reconciliation_session_start",
  "bank_reconciliation_session_complete",
  "bank_reconciliation_session_cancel",
  "bank_reconciliation_session_writeoff",
  "bank_reconciliation_item_set",
] as const;

describe("Bank reconciliation is branch + permission scoped", () => {
  it("assert_can_reconcile_bank is the single permission authority", () => {
    const src = finalDefinition("assert_can_reconcile_bank");
    expect(src).toMatch(/finance\.reconcile_bank/);
  });

  it("_bank_reconciliation_assert_account performs the permission check", () => {
    const src = finalDefinition("_bank_reconciliation_assert_account");
    expect(src).toMatch(/assert_can_reconcile_bank\s*\(/);
  });

  it.each(DIRECTLY_GATED.filter((n) => n !== "assert_can_reconcile_bank"))(
    "%s calls assert_can_reconcile_bank",
    (name) => {
      expect(finalDefinition(name)).toMatch(/assert_can_reconcile_bank\s*\(/);
    },
  );

  it.each(GATED_VIA_ACCOUNT_ASSERT)(
    "%s authorizes through _bank_reconciliation_assert_account",
    (name) => {
      const src = finalDefinition(name);
      expect(
        /_bank_reconciliation_assert_account\s*\(/.test(src) ||
          /assert_can_reconcile_bank\s*\(/.test(src),
      ).toBe(true);
    },
  );

  it("every reconciliation seam is SECURITY DEFINER with a pinned search_path", () => {
    for (const name of [...DIRECTLY_GATED, ...GATED_VIA_ACCOUNT_ASSERT]) {
      const src = finalDefinition(name);
      expect(src, `${name} must be SECURITY DEFINER`).toMatch(/SECURITY\s+DEFINER/i);
      expect(src, `${name} must pin search_path`).toMatch(/SET\s+search_path/i);
    }
  });

  it("bank_reconciliation_sessions is branch-aware", () => {
    expect(corpus).toMatch(
      /bank_reconciliation_sessions[\s\S]{0,400}?branch_id\s+uuid/i,
    );
  });

  it("session and match RLS name the permission and the branch clause", () => {
    for (const op of ["select", "insert", "update", "delete"]) {
      expect(corpus).toMatch(
        new RegExp(`CREATE POLICY\\s+bank_recon_sessions_${op}_perm_v1`, "i"),
      );
    }
    expect(corpus).toMatch(/CREATE POLICY\s+bank_recon_matches_write_perm_v1/i);
    expect(corpus).toMatch(/has_finance_permission\([\s\S]{0,200}?finance\.reconcile_bank/);
    expect(corpus).toMatch(/user_can_access_branch\(\s*auth\.uid\(\)\s*,\s*branch_id\s*\)/);
  });

  it("the hook submits through the session seams, never a direct table write", () => {
    const src = read("src/hooks/useReconciliationSessions.ts");
    for (const rpc of [
      "bank_reconciliation_session_start",
      "bank_reconciliation_session_writeoff",
      "bank_reconciliation_session_complete",
      "bank_reconciliation_session_cancel",
    ]) {
      expect(src, `hook must call ${rpc}`).toContain(rpc);
    }
    expect(src).not.toMatch(
      /from\(\s*["']bank_reconciliation_(sessions|items)["']\s*\)\s*\.\s*(insert|update|delete|upsert)/,
    );
  });

  it("the hook scopes reads and surfaces the permission as read-only UI state", () => {
    const src = read("src/hooks/useReconciliationSessions.ts");
    expect(src).toMatch(/useFinanceScope\(\)/);
    expect(src).toMatch(/useFinancePermission\(\s*["']finance\.reconcile_bank["']\s*\)/);
    expect(src).toMatch(/branch_id\.eq\.\$\{scope\.branchId\}/);
    expect(src).toMatch(/branch_id\.is\.null/);
    expect(src).toMatch(/canReconcile/);
    expect(src).toMatch(/mapReconcilePermErr/);
  });

  it("BankReconciliation page shows scope and gates write affordances", () => {
    const src = read("src/pages/BankReconciliation.tsx");
    expect(src).toMatch(/<FinanceScopeBadge\b/);
    expect(src).not.toMatch(/<BranchReadOnlyBanner/);
    expect(src).toMatch(/disabled=\{[^}]*!canReconcile/);
    expect(src).not.toMatch(
      /PermissionGate\s+permission=["']manageFinancials["'][\s\S]{0,200}Reconcile/,
    );
  });
});
