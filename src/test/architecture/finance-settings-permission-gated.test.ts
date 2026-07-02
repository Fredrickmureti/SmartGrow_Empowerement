import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Wave-3 — finance settings cards must surface a permission gate matching
 * the server-side RLS / trigger requirement. This test prevents future
 * regressions where a Save button is wired up without checking
 * `useFinancePermission`, which would let the UI silently 401 against
 * RLS-hardened tables.
 */
const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("Finance settings cards — permission gates", () => {
  it("LockDatesCard checks finance.manage_periods and disables inputs", () => {
    const src = read("src/components/finance/LockDatesCard.tsx");
    expect(src).toMatch(
      /useFinancePermission\(["']finance\.manage_periods["']\)/,
    );
    expect(src).toMatch(/readOnly\s*=\s*!canManagePeriods/);
    expect(src).toMatch(/disabled=\{readOnly\}/);
  });

  it("DefaultAccountsConfig checks finance.manage_settings and gates Save", () => {
    const src = read("src/components/finance/DefaultAccountsConfig.tsx");
    expect(src).toMatch(
      /useFinancePermission\(["']finance\.manage_settings["']\)/,
    );
    expect(src).toMatch(/readOnly\s*=\s*!canManageSettings/);
    // Save button must be disabled when read-only
    expect(src).toMatch(/disabled=\{isSaving\s*\|\|\s*readOnly\}/);
  });

  it("FinanceAccountingControls gates journals/rules/fx by distinct perms", () => {
    const src = read("src/components/finance/FinanceAccountingControls.tsx");
    expect(src).toMatch(
      /useFinancePermission\(["']finance\.manage_settings["']\)/,
    );
    expect(src).toMatch(
      /useFinancePermission\(["']finance\.manage_je["']\)/,
    );
    expect(src).toMatch(
      /useFinancePermission\(["']finance\.reconcile_bank["']\)/,
    );
    expect(src).toMatch(/journalsReadOnly/);
    expect(src).toMatch(/rulesReadOnly/);
    expect(src).toMatch(/fxReadOnly/);
  });
});