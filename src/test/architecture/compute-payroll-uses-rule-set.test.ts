/**
 * R3 architecture guard — compute-payroll engine immutability.
 *
 * The payroll engine MUST resolve salary components via the immutable
 * `resolve_or_publish_rule_set` RPC. It must NOT read live `salary_components`
 * at compute time, otherwise historical payslips would silently drift after
 * admins edit a structure.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENGINE = readFileSync(
  join(process.cwd(), "supabase", "functions", "compute-payroll", "index.ts"),
  "utf8",
);

describe("R3 — compute-payroll uses rule sets, not live components", () => {
  it("calls resolve_or_publish_rule_set per structure", () => {
    expect(ENGINE).toMatch(/resolve_or_publish_rule_set/);
    expect(ENGINE).toMatch(/p_structure_id:\s*sid/);
    expect(ENGINE).toMatch(/p_as_of:\s*pay_period_end/);
  });

  it("never reads live salary_components at compute time", () => {
    // Allow only references inside comments (lines beginning with // or /* / *).
    const lines = ENGINE.split("\n");
    const offending = lines.filter((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        return false;
      }
      return /\bfrom\(["']salary_components["']\)/.test(line);
    });
    expect(offending).toEqual([]);
  });

  it("stamps payslips with rule_set_id / version / hash", () => {
    expect(ENGINE).toMatch(/rule_set_id:\s*employeeRuleSet\?\.id/);
    expect(ENGINE).toMatch(/rule_set_version:\s*employeeRuleSet\?\.version/);
    expect(ENGINE).toMatch(/rule_set_hash:\s*employeeRuleSet\?\.rule_hash/);
  });

  it("stamps every payslip_line with rule_version_id and rule_version_hash", () => {
    expect(ENGINE).toMatch(/rule_version_id:\s*ps\.rule_set_id/);
    expect(ENGINE).toMatch(/rule_version_hash:\s*ps\.rule_set_hash/);
  });
});
