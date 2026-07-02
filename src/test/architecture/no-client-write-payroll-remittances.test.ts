/**
 * Architecture guard — the legacy `payroll_remittances` table is read-only
 * from the client. All payment recording must go through the GL-backed
 * `post-remittance-payment` edge function which writes to
 * `payroll_liabilities` + `payroll_remittance_payments` and posts a real
 * journal entry.
 *
 * Allowed exceptions:
 *   - generated Supabase types
 *   - this guard file itself
 *   - the legacy mirror inside the edge function (server, not client)
 *   - documentation-only references in comments
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ALLOWLIST = [
  /^src\/integrations\/supabase\/types\.ts$/,
  /^src\/test\/architecture\/no-client-write-payroll-remittances\.test\.ts$/,
];

describe("payroll architecture guard — payroll_remittances is read-only from the client", () => {
  it("no client file performs .insert/.update/.delete on payroll_remittances", () => {
    const candidates = execSync(
      'rg --files-with-matches "payroll_remittances" src/ || true',
      { encoding: "utf8" }
    )
      .split("\n")
      .filter(Boolean)
      .filter((p) => !ALLOWLIST.some((re) => re.test(p)));

    const offenders: string[] = [];
    for (const p of candidates) {
      const src = readFileSync(p, "utf8");
      // strip line comments and block comments before matching
      const stripped = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/[^\n]*/g, "$1");
      // Look for any chained mutation on the table name
      const re =
        /\bfrom\s*\(\s*["']payroll_remittances["']\s*\)[\s\S]{0,400}?\.(insert|update|upsert|delete)\s*\(/;
      if (re.test(stripped)) offenders.push(p);
    }

    expect(
      offenders,
      `Client files mutating payroll_remittances directly:\n${offenders.join("\n")}\n` +
        "Use the post-remittance-payment edge function instead.",
    ).toEqual([]);
  });
});
