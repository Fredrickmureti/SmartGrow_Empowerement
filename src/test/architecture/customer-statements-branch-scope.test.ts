import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Phase 5 — Customer Statements branch-scope wiring.
 *
 * The page + hook + preview component must collectively guarantee that:
 *   - the statement list is scoped via applyBranchFilter(...) on
 *     `customer_statements`,
 *   - the generated statement payload carries business_id + branch_id,
 *   - the saved statement row is stamped with branch_id,
 *   - the rendered statement displays the issuing scope (business · branch)
 *     so a printed/emailed statement can never be mistaken for an
 *     HQ-wide document when it was in fact a branch statement.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Customer Statements — branch scope wiring", () => {
  it("page renders the FinanceScopeBadge", () => {
    const src = read("src/pages/CustomerStatements.tsx");
    expect(src).toMatch(/from\s+["']@\/components\/finance\/FinanceScopeBadge["']/);
    expect(src).toMatch(/<FinanceScopeBadge\s*\/>/);
  });

  it("hook list query is branch-filtered and keyed on branchId", () => {
    const src = read("src/hooks/useCustomerStatements.ts");
    expect(src).toMatch(/applyBranchFilter\([^)]*branchId\)/);
    expect(src).toMatch(/queryKey:\s*\[[^\]]*branchId[^\]]*\]/);
  });

  it("hook stamps branch_id on the saved statement row", () => {
    const src = read("src/hooks/useCustomerStatements.ts");
    // The insert payload must include branch_id (from data.branch_id ?? branchId).
    expect(src).toMatch(/branch_id:\s*data\.branch_id\s*\?\?\s*branchId/);
  });

  it("generated statement data carries business_id + branch_id", () => {
    const src = read("src/hooks/useCustomerStatements.ts");
    expect(src).toMatch(/business_id:\s*currentBusiness!?\.id/);
    expect(src).toMatch(/branch_id:\s*branchId/);
  });

  it("preview component renders the scope label", () => {
    const src = read("src/components/sales/StatementPreview.tsx");
    expect(src).toMatch(/StatementScopeLabel/);
  });
});
