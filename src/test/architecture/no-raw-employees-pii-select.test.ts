/**
 * C-HR-4 — Architecture guard: no client code may SELECT PII columns
 * directly off the `employees` table. PII reads must go through
 * `v_employees_safe` (masked) or the audited `get_employee_pii` RPC.
 *
 * `select("*")` against `employees` is also banned because the REVOKE
 * on the masked columns turns that into a 403 at runtime.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const PII_COLUMNS = [
  "national_id",
  "date_of_birth",
  "personal_phone",
  "address_line1",
  "address_line2",
  "city",
  "county",
  "postal_code",
  "emergency_contact_name",
  "emergency_contact_phone",
  "emergency_contact_relationship",
  "marital_status",
  "gender",
  "bank_name",
  "bank_branch",
  "bank_account_number",
  "bank_code",
];

const ALLOW_LIST = new Set<string>([
  // Audited PII reader hook is allowed to reference the field names.
  "src/hooks/useEmployeePii.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) {
      if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") || p.endsWith(".tsx")) {
      out.push(p);
    }
  }
  return out;
}

describe("employees PII read lockdown", () => {
  it("no client SELECT of PII columns directly against the employees table", () => {
    const files = walk("src").filter(
      (f) =>
        !f.includes("/test/") &&
        !f.endsWith(".d.ts") &&
        !f.includes("integrations/supabase/types.ts"),
    );

    const violations: string[] = [];
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOW_LIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");

      // Match `.from("employees") ... .select("...")` chains
      const re = /\.from\(["']employees["']\)[\s\S]{0,300}?\.select\(\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const cols = m[1];
        if (cols.trim() === "*" || cols.includes("*,")) {
          violations.push(`${rel}: select("*") against employees — use v_employees_safe`);
          continue;
        }
        for (const c of PII_COLUMNS) {
          const colRe = new RegExp(`(^|[,\\s(])${c}([,\\s)]|$)`);
          if (colRe.test(cols)) {
            violations.push(`${rel}: selects PII column "${c}" from employees`);
          }
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
