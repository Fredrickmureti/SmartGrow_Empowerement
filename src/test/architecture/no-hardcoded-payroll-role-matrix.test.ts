/**
 * Phase 3 architecture guard — single source of truth for the payroll
 * account role matrix.
 *
 * The COGS / generic-AP / header-account rules are enforced by:
 *   1. payroll_account_role_policy (seed migration 20260525204357)
 *   2. _payroll_assert_mapping_role (BEFORE INSERT/UPDATE on
 *      default_account_settings) — consults #1.
 *   3. _payroll_assert_je_line_account (BEFORE INSERT/UPDATE on
 *      journal_entry_lines, fires when source_type='payroll') — enforces
 *      the same denial classes.
 *   4. payroll_mapping_findings view — read by the UI, also consults #1.
 *
 * Re-encoding the matrix anywhere else (a second view, a TS map, a hook,
 * an edge function) is how Phase 2 / Phase 3 silently rot. This guard
 * fails the build when a parallel hardcoded matrix sneaks back in.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  // Single source of truth — the seed migration.
  /^supabase\/migrations\/20260525204357_/,
  // Mapping trigger source migration — references the policy table by design.
  // (Same migration timestamp; allowlisted above.)
  // The view we just rewrote is allowed to reference the policy table.
  /^supabase\/migrations\/\d+_[a-z0-9-]+\.sql$/, // any migration MAY reference it (policy reads ok)
  // The audit + arch test itself.
  /^docs\/audit\//,
  /^src\/test\/architecture\/no-hardcoded-payroll-role-matrix\.test\.ts$/,
  /^\.lovable\/plan\.md$/,
];

// Patterns that indicate a re-encoded role matrix (account_type-or-detail_type
// hardcoded next to a payroll setting_key in a single literal).
const RED_FLAGS = [
  // TS object literal mapping a payroll setting_key to an account_type string.
  /["']salary_expense["']\s*:\s*\{[^}]*account_type/i,
  /["']net_salary_payable["']\s*:\s*\{[^}]*account_type/i,
  // TS array of forbidden setting_key/account_type pairs.
  /forbiddenPayrollMappings\s*=\s*\[/,
  // Embedded SQL CASE that re-encodes the COGS/AP denial without policy lookup.
  /WHEN\s+das\.setting_key\s+LIKE\s+'%_payable'[^\n]+lower\(a\.name\)\s+IN/i,
];

describe("Phase 3 — no parallel hardcoded payroll role matrix", () => {
  it("only the policy table + its declared consumers encode the role matrix", () => {
    const files = execSync(
      "rg --files-with-matches -e 'payroll_account_role_policy' -e 'salary_expense_mapped_to_cogs' -e 'payroll_payable_mapped_to_generic_ap' supabase/ src/ || true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean);

    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWLIST.some((re) => re.test(f))) continue;
      const src = readFileSync(f, "utf8");
      if (RED_FLAGS.some((re) => re.test(src))) offenders.push(f);
    }

    expect(
      offenders,
      `Hardcoded payroll role matrix re-encoded in:\n${offenders.join("\n")}\n` +
        "Single source of truth is public.payroll_account_role_policy. Extend that table instead."
    ).toEqual([]);
  });
});
