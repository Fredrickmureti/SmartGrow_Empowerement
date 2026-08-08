/**
 * Guard — chart provisioning must finish by mapping every standard role.
 *
 * `provision_missing_system_accounts` short-circuits on "already_eligible",
 * which leaves roles such as `operating_expenses` (the product
 * purchase/expense default) without a `default_account_settings` row. The
 * repair routine `ensure_default_account_mappings` closes that gap and must
 * stay wired into provisioning.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

const MIGRATION_DIR = "supabase/migrations";

function latestDefinitionOf(fnName: string): string {
  const files = readdirSync(MIGRATION_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .reverse();
  const needle = `FUNCTION public.${fnName}(`;
  for (const f of files) {
    const sql = readFileSync(`${MIGRATION_DIR}/${f}`, "utf8");
    if (sql.includes(needle)) return sql;
  }
  throw new Error(`No migration defines ${fnName}`);
}

describe("default account role coverage", () => {
  it("ensure_default_account_mappings exists", () => {
    expect(() => latestDefinitionOf("ensure_default_account_mappings")).not.toThrow();
  });

  it("provisioning calls the mapping repair", () => {
    const sql = latestDefinitionOf("provision_default_chart_of_accounts");
    expect(sql).toContain("ensure_default_account_mappings");
  });

  it("repair provisions through the canonical system-account helper", () => {
    const sql = latestDefinitionOf("ensure_default_account_mappings");
    expect(sql).toContain("upsert_system_account");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+public\.accounts/i);
  });

  it("statutory payroll roles stay owned by the country packs", () => {
    const sql = latestDefinitionOf("ensure_default_account_mappings");
    expect(sql).toContain("category <> 'payroll'");
  });
});
