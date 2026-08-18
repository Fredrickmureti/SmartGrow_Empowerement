/**
 * Phase 12 — Bank Feeds architecture guard.
 *
 * Bank-feed transactions inherit their branch from the parent bank_account.
 * The list query, the React-effect dep, the categorize/bulk-categorize
 * mutations, and the page header must all be branch-aware so a branch user
 * sees only their branch's feed and a branch switch never leaves stale
 * numbers on screen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const listMigrations = () =>
  readdirSync(join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql"));

describe("Phase 12 — Bank Feeds is branch-scoped end-to-end", () => {
  it("useBankTransactions consumes useFinanceScope", () => {
    const src = read("src/hooks/useBankTransactions.ts");
    expect(src).toMatch(/from ["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(src).toMatch(/useFinanceScope\(\)/);
  });

  it("useBankTransactions passes _branch_id to get_bank_transactions_paginated", () => {
    const src = read("src/hooks/useBankTransactions.ts");
    expect(src).toMatch(/get_bank_transactions_paginated/);
    expect(src).toMatch(/_branch_id:\s*scope\.branchId/);
  });

  it("useBankTransactions re-fetches when scope.branchId changes", () => {
    const src = read("src/hooks/useBankTransactions.ts");
    // The effect dep array must include scope.branchId
    expect(src).toMatch(
      /\[\s*currentOrg\?\.id\s*,\s*currentBusiness\?\.id\s*,\s*scope\.branchId\s*,\s*JSON\.stringify\(filters\)\s*\]/,
    );
  });

  it("useBankTransactions categorizes through the server seam, never a direct update", () => {
    const src = read("src/hooks/useBankTransactions.ts");
    // Categorization is server-owned (`bank_transaction_set_category`), which
    // derives org/business scope itself — a client-side `.update({ category })`
    // would bypass the seam and its audit trail.
    expect(src).toMatch(/rpc\(\s*["']bank_transaction_set_category["']/);
    expect(src).not.toMatch(/from\(\s*["']bank_transactions["']\s*\)[\s\S]{0,200}?\.update\(/);
  });


  it("useBankTransactions maps RLS / 42501 errors to a friendly bank-feed message", () => {
    const src = read("src/hooks/useBankTransactions.ts");
    expect(src).toMatch(/mapBankFeedPermErr/);
    expect(src).toMatch(/don't have permission to categorize or reconcile bank feed transactions/i);
  });

  it("BankFeeds.tsx renders the FinanceScopeBadge and BranchReadOnlyBanner", () => {
    const src = read("src/pages/BankFeeds.tsx");
    expect(src).toMatch(/<FinanceScopeBadge\s*\/>/);
    expect(src).not.toMatch(/<BranchReadOnlyBanner/);
  });

  it("BankFeeds.tsx prints the active scope label in the subtitle when multi-branch", () => {
    const src = read("src/pages/BankFeeds.tsx");
    expect(src).toMatch(/scope\.hasMultipleBranches/);
    expect(src).toMatch(/scope\.scopeLabel/);
  });

  it("BankFeeds.tsx categorize + bulk-categorize stamp explicit org+business filters", () => {
    const src = read("src/pages/BankFeeds.tsx");
    // handleCategorize
    expect(src).toMatch(
      /\.update\(\{ category, category_confidence: 1\.0 \}\)[\s\S]{0,400}\.eq\(['"]id['"],\s*transactionId\)[\s\S]{0,400}\.eq\(['"]organization_id['"],\s*currentOrg\.id\)[\s\S]{0,400}\.eq\(['"]business_id['"],\s*currentBusiness\.id\)/,
    );
    // handleBulkCategorize uses .in('id', selectedTransactions) followed by org+business eq
    expect(src).toMatch(
      /\.in\(['"]id['"],\s*selectedTransactions\)[\s\S]{0,400}\.eq\(['"]organization_id['"],\s*currentOrg\.id\)[\s\S]{0,400}\.eq\(['"]business_id['"],\s*currentBusiness\.id\)/,
    );
  });

  it("Phase 12 migration ships get_bank_transactions_paginated with branch derived from bank_accounts", () => {
    const matches = listMigrations();
    // Branch scope MUST be derived from the parent bank_account, not from a
    // (non-existent) bank_transactions.branch_id column. The most recent
    // matching migration wins; older migrations may carry the broken pattern.
    const found = matches
      .sort()
      .reverse()
      .map((f) => read(`supabase/migrations/${f}`))
      .find(
        (sql) =>
          /CREATE OR REPLACE FUNCTION public\.get_bank_transactions_paginated/.test(sql) &&
          /_branch_id\s+uuid\s+DEFAULT\s+NULL/.test(sql) &&
          /ba\.branch_id\s*=\s*_branch_id/.test(sql) &&
          !/bt\.branch_id/.test(sql),
      );
    expect(found, "Canonical bank-feeds RPC (branch via bank_accounts) not found").toBeTruthy();
  });
});
