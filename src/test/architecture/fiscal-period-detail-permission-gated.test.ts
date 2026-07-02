import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wave-4 follow-up — the fiscal period DETAIL page (FiscalPeriodDetail.tsx)
 * must be gated the same way the LIST page is. The previous wave only gated
 * the list, leaving the detail route as a way for a Branch-A admin to click
 * Close / Reopen / Override and trip the DB trigger
 * `trg_fiscal_periods_no_branch_context` instead of getting a clean read-only
 * UI. This test prevents that regression.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("FiscalPeriodDetail — branch / permission gating", () => {
  const src = read("src/pages/finance/FiscalPeriodDetail.tsx");

  it("imports useFinancePermission, useFinanceScope and BranchReadOnlyBanner", () => {
    expect(src).toMatch(/from\s+["']@\/hooks\/finance\/useFinancePermission["']/);
    expect(src).toMatch(/from\s+["']@\/hooks\/finance\/useFinanceScope["']/);
    expect(src).toMatch(/from\s+["']@\/components\/finance\/BranchReadOnlyBanner["']/);
  });

  it("derives canEditPeriods from finance.manage_periods AND branch context", () => {
    expect(src).toMatch(/useFinancePermission\(["']finance\.manage_periods["']\)/);
    // Canonical predicate: NON-HQ branch in a multi-branch business.
    expect(src).toMatch(/scope\.isBranchScopedReadOnly/);
    expect(src).toMatch(/canEditPeriods\s*=\s*canManagePeriods\s*&&\s*!insideBranchContext/);
  });

  it("renders the BranchReadOnlyBanner near the top of the page", () => {
    expect(src).toMatch(/<BranchReadOnlyBanner\s+area=["']Fiscal Periods["']/);
  });

  it("guards every Close / Reopen / Override button with canEditPeriods", () => {
    // Match the three buttons we know about. Each MUST live inside a
    // `canEditPeriods &&` guard, otherwise a branch admin can click them.
    const closeMatches = src.match(/isOpen\s*&&\s*canEditPeriods\s*&&/g) ?? [];
    expect(closeMatches.length).toBeGreaterThanOrEqual(2); // header + override
    expect(src).toMatch(/isClosed\s*&&\s*canEditPeriods\s*&&/);
  });
});
