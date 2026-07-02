/**
 * Architecture guard — no references to the dropped `payroll_account_mappings` table.
 *
 * The legacy table was removed in `20260427002430_*.sql`; GL routing is now unified
 * on `default_account_settings`. Two SECURITY DEFINER functions
 * (`assert_payroll_ready`, `refresh_payroll_setup_status`) accidentally kept
 * querying the dropped relation, breaking compute-payroll preview with
 * `42P01` until the follow-up fix migration. This guard prevents the regression.
 *
 * Allowed references: the original CREATE migration, the DROP migration,
 * the rewrite migration, the legacy-cleanup migrations that DROP POLICY,
 * a legacy data-migration helper, and this guard file itself.
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

const ALLOWLIST = [
  // Original schema
  /^supabase\/migrations\/20260225080720_/,
  // Branch-scoped policy migration that DROPs old policies on the legacy table
  /^supabase\/migrations\/20260425151558_/,
  // Legacy migrations that referenced the table before it was dropped
  /^supabase\/migrations\/20260425110730_/,
  /^supabase\/migrations\/20260425160916_/,
  // The DROP TABLE migration
  /^supabase\/migrations\/20260427002430_/,
  // Rewrite migrations that document the move
  /^supabase\/migrations\/20260507201815_/,
  /^supabase\/migrations\/20260507210838_/,
  // Post-rewrite guard migration that introspects pg_proc for stale references
  /^supabase\/migrations\/20260507220343_/,
  // Hook documents the removal in a comment
  /^src\/hooks\/usePayrollAccountMappings\.ts$/,
  // Edge function documents the removal in a comment
  /^supabase\/functions\/post-payroll-gl\/index\.ts$/,
  // This guard
  /^src\/test\/architecture\/no-dropped-payroll-tables\.test\.ts$/,
];

describe("payroll architecture guard — dropped tables", () => {
  it("no executable references to public.payroll_account_mappings", () => {
    const out = execSync(
      "rg --files-with-matches 'payroll_account_mappings' supabase/ src/ || true",
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .filter((path) => !ALLOWLIST.some((re) => re.test(path)));

    expect(
      out,
      `Found references to dropped table payroll_account_mappings in:\n${out.join("\n")}\n` +
        `Use public.default_account_settings (setting_key/account_id) instead.`
    ).toEqual([]);
  });
});
