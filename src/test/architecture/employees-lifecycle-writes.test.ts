/**
 * Wave 2C — Lifecycle/salary write lockdown.
 *
 * The `employees` table's `is_active`, `termination_date`, `hire_date`,
 * `basic_salary`, `housing_allowance`, `transport_allowance`, and
 * `other_allowances` columns are now derived/trigger-maintained from
 * `employments` and `employee_contracts`. Direct writes are forbidden
 * outside of:
 *   - DB triggers (sync_employee_from_employments, trg_sync_contract_to_employee)
 *   - `src/hooks/hr/useEmployments.ts` (the canonical lifecycle hook)
 *   - `src/hooks/payroll/*` contract hooks (compensation)
 *
 * Any new UI surface that needs to flip lifecycle or change salary
 * MUST go through useEmployments or the contract editor.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN_FIELDS = [
  "is_active",
  "termination_date",
  "hire_date",
  "basic_salary",
  "housing_allowance",
  "transport_allowance",
  "other_allowances",
];

// Files explicitly allowed to write these fields on the employees table.
// Keep this list short — every entry is an exception that should be justified.
const ALLOW_LIST = new Set<string>([
  // Lifecycle hook is the canonical writer (and only via employments, not employees).
  "src/hooks/hr/useEmployments.ts",
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

describe("employees lifecycle/salary write lockdown", () => {
  it("no UI code writes lifecycle/salary fields directly on the employees table", () => {
    const files = walk("src").filter(
      (f) => !f.includes("/test/") && !f.endsWith(".d.ts") && !f.includes("integrations/supabase/types.ts"),
    );

    const violations: string[] = [];
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOW_LIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!/\.from\(["']employees["']\)/.test(src)) continue;

      // Find each .from("employees") ... .update(...) chain and inspect the payload.
      const updateRegex = /\.from\(["']employees["']\)[\s\S]{0,400}?\.update\(\s*(\{[\s\S]*?\})/g;
      let m: RegExpExecArray | null;
      while ((m = updateRegex.exec(src))) {
        const payload = m[1];
        for (const field of FORBIDDEN_FIELDS) {
          // Match `field:` or `"field":` as an object key.
          const keyRegex = new RegExp(`(^|[,{\\s])["']?${field}["']?\\s*:`);
          if (keyRegex.test(payload)) {
            violations.push(`${rel} writes employees.${field}`);
          }
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
