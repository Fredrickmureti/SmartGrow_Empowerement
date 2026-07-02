import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 7 — Manual journal-entry create/edit and void/reverse must be
 * gated by `finance.manage_je` and `finance.void_je` at company scope,
 * both in the UI and inside the canonical RPCs. Auto-JEs from source
 * documents (invoices, bills, payments, payroll, FX, depreciation) keep
 * working because they call the RPC as the workspace owner/admin path,
 * which short-circuits the gate.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const MIGRATIONS_DIR = join(ROOT, "supabase", "migrations");

describe("Journal Entries — business-level permission gate", () => {
  const page = read("src/pages/JournalEntries.tsx");

  it("page imports the canonical scope primitives", () => {
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(page).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(page).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
  });

  it("page renders FinanceScopeBadge + BranchReadOnlyBanner", () => {
    expect(page).toMatch(/<FinanceScopeBadge\s*\/>/);
    expect(page).not.toMatch(/<BranchReadOnlyBanner/);
  });

  it("page calls useFinancePermission for both manage_je and void_je", () => {
    expect(page).toMatch(/useFinancePermission\(["']finance\.manage_je["']\)/);
    expect(page).toMatch(/useFinancePermission\(["']finance\.void_je["']\)/);
  });

  it("New Entry / Import are gated by canManageJE; Reverse / Void are gated by canVoidJE", () => {
    expect(page).toMatch(/canManageJE\s*&&[\s\S]{0,1500}New Entry/);
    expect(page).toMatch(/canVoidJE[\s\S]{0,2500}Create Reversal/);
    expect(page).toMatch(/canVoidJE[\s\S]{0,3000}Void/);
  });

  it("useJournalEntries cache key includes branch so a branch switch invalidates", () => {
    const hook = read("src/hooks/useJournalEntries.ts");
    expect(hook).toMatch(/queryKey:\s*\[\s*["']journal-entries["'],[^\]]*currentBranch\?\.id/);
  });

  const migs = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => ({ file: f, sql: readFileSync(join(MIGRATIONS_DIR, f), "utf8") }));

  const gateMig = migs.find(({ sql }) =>
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_manage_je/i.test(sql) &&
    /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.assert_can_void_je/i.test(sql),
  );

  it("assert_can_manage_je / assert_can_void_je migration exists with proper error codes", () => {
    expect(gateMig, "Phase 7 JE gate migration is missing").toBeDefined();
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_JE_MANAGE/);
    expect(gateMig?.sql).toMatch(/INSUFFICIENT_PRIVILEGE_JE_VOID/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(\s*_uid\s*,\s*'finance\.manage_je'/);
    expect(gateMig?.sql).toMatch(/has_finance_permission\(\s*_uid\s*,\s*'finance\.void_je'/);
  });

  it("create_journal_entry_atomic and void_journal_entry_atomic both call the assert helpers", () => {
    const sql = gateMig!.sql;
    // create_journal_entry_atomic body asserts manage_je
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.create_journal_entry_atomic[\s\S]*?PERFORM\s+public\.assert_can_manage_je/i,
    );
    // void_journal_entry_atomic body asserts void_je
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.void_journal_entry_atomic[\s\S]*?PERFORM\s+public\.assert_can_void_je/i,
    );
  });
});
