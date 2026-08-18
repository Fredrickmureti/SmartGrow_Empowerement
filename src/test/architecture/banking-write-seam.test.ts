/**
 * Banking Wave 1 — the bank-account write seam is a monopoly.
 *
 * One engine owns every mutation of `bank_accounts`:
 *   bank_account_create / bank_account_update / bank_account_transition /
 *   bank_account_delete_draft / bank_account_reset_opening_balances
 *
 * Those SECURITY DEFINER RPCs own lifecycle transitions, currency validation,
 * optimistic concurrency (`row_version`) and — critically — opening-balance
 * posting through `post_journal_entry_atomic` in the SAME transaction as the
 * account row. INSERT/UPDATE/DELETE on the table is revoked from
 * `authenticated`, so any direct browser write is a bug that fails here first.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, it, expect } from "vitest";

const root = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry === "__snapshots__") continue;
      walk(full, out);
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Client-side writes are only legal through the RPC seam. */
const WRITE_CALL =
  /\.from\(\s*["'`]bank_accounts["'`]\s*\)\s*(?:[\s\S]{0,400}?)\.(insert|update|upsert|delete)\(/;

describe("bank account write seam", () => {
  it("no application code writes bank_accounts directly", () => {
    const offenders: string[] = [];
    for (const file of walk(join(root, "src"))) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("bank_accounts")) continue;
      if (WRITE_CALL.test(src)) offenders.push(relative(root, file));
    }
    expect(offenders).toEqual([]);
  });

  it("useBankAccounts mutates only through the seam RPCs", () => {
    const src = readFileSync(join(root, "src/hooks/useBankAccounts.ts"), "utf8");
    for (const fn of [
      "bank_account_create",
      "bank_account_update",
      "bank_account_transition",
      "bank_account_delete_draft",
    ]) {
      expect(src).toContain(fn);
    }
    // Lifecycle + concurrency are first-class on the client contract.
    expect(src).toContain("lifecycle_status");
    expect(src).toContain("row_version");
  });

  it("the browser never posts the opening-balance journal entry itself", () => {
    const create = readFileSync(
      join(root, "src/features/finance/banking/BankAccountCreatePage.tsx"),
      "utf8",
    );
    expect(create).not.toContain("post_journal_entry_atomic");
    expect(create).toContain("bank_account");
  });

  it("sync status is owned by the sync function, not the browser", () => {
    const src = readFileSync(join(root, "src/hooks/useBankAccounts.ts"), "utf8");
    expect(src).not.toMatch(/sync_status:\s*["'`]syncing["'`]/);
    const fn = readFileSync(
      join(root, "supabase/functions/sync-bank-transactions/index.ts"),
      "utf8",
    );
    expect(fn).toMatch(/sync_status:\s*'syncing'/);
  });

  it("migration reset reverses the opening-balance entry via the RPC", () => {
    const src = readFileSync(join(root, "src/hooks/useMigrationSession.ts"), "utf8");
    expect(src).toContain("bank_account_reset_opening_balances");
  });
});
