/**
 * Banking ownership boundary — architecture guards.
 *
 * Backstop for the invariants enforced by the 2026-05-16 migration:
 *   R1/R2 — duplicate bank-connection prevention (DB unique indexes)
 *   R3    — bank_transactions scope inherits from parent bank_account (trigger)
 *   R5    — is_shared ⇔ branch_id IS NULL (CHECK)
 *   R7    — sync edge function explicitly stamps business_id + branch_id
 *
 * These tests prevent regressions where a future agent removes the
 * scope-stamping or reintroduces an unscoped insert path.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();

describe("banking ownership architecture", () => {
  it("sync-bank-transactions stamps business_id and branch_id on inserts (R7)", () => {
    const src = readFileSync(
      join(root, "supabase/functions/sync-bank-transactions/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/business_id:\s*\(account as any\)\.business_id/);
    expect(src).toMatch(/branch_id:\s*\(account as any\)\.branch_id/);
  });

  it("useBankAccounts maps the write-seam HINTs (R1/R2/R5)", () => {
    const src = readFileSync(join(root, "src/hooks/useBankAccounts.ts"), "utf8");
    expect(src).toContain("BANK_ACCOUNT_ALREADY_CONNECTED");
    expect(src).toContain("BANK_ACCOUNT_VERSION_CONFLICT");
    expect(src).toContain("bank_accounts_shared_branch_consistency");
  });


  it("useReconciliationSessions maps the open-session unique violation (R4)", () => {
    const src = readFileSync(
      join(root, "src/hooks/useReconciliationSessions.ts"),
      "utf8",
    );
    expect(src).toContain("bank_reconciliation_one_open_per_account");
  });

  it("BankAccountCreatePage locks the branch selector for non-HQ branch users", () => {
    const src = readFileSync(
      join(root, "src/features/finance/banking/BankAccountCreatePage.tsx"),
      "utf8",
    );
    expect(src).toContain("branchSelectorLocked");
    // is_shared is derived server-side from branch_id; the page only sends branch_id.
    expect(src).toContain("branch_id: resolvedBranchId");
  });


  it("BankAccountEditPage enforces branch lock + re-attribute confirmation (G1)", () => {
    const src = readFileSync(
      join(root, "src/features/finance/banking/BankAccountEditPage.tsx"),
      "utf8",
    );
    expect(src).toContain("branchSelectorLocked");
    expect(src).toContain("requiresReattributeConfirm");
    expect(src).toContain("reattributeConfirmed");
    expect(src).toMatch(/is_shared:\s*resolvedBranchId === null/);
  });

  it("StartReconciliationPage surfaces Resume CTA for an existing open session (G2)", () => {
    const src = readFileSync(
      join(root, "src/features/finance/reconciliation/StartReconciliationPage.tsx"),
      "utf8",
    );
    expect(src).toContain("useReconciliationSessions");
    expect(src).toContain("openSessionForAccount");
    expect(src).toContain("Resume reconciliation");
  });

  it("useBankAccounts duplicate toast deep-links to /banking (G3)", () => {
    const src = readFileSync(join(root, "src/hooks/useBankAccounts.ts"), "utf8");
    expect(src).toContain("bank_accounts_manual_no_provider_unique");
    expect(src).toMatch(/label:\s*"Open bank accounts"/);
  });
});
