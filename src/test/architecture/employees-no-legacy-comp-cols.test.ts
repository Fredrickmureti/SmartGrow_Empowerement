/**
 * Wave 1.1 guard.
 *
 * The following columns no longer exist on `public.employees` after Wave 1.1:
 *   - basic_salary, housing_allowance, transport_allowance (Phase A, prior wave)
 *   - department, position, insurance_premium (Phase B, this wave)
 *
 * Compensation lives on `employee_contracts` + `contract_compensation_components`.
 * Org placement uses `department_id` / `job_position_id` (FK to `departments` /
 * `job_positions`). Readers see the legacy column names via `v_employees_safe`,
 * which sources them from the canonical tables.
 *
 * This test fails CI if any production code re-introduces a direct
 * `.from("employees")` query that selects one of the dropped columns —
 * such a query would 400 at runtime ("column employees.<x> does not exist").
 * Use `v_employees_safe` instead, or read from `employee_contracts` /
 * `contract_compensation_components` directly.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const DROPPED_COLS = [
  "basic_salary",
  "housing_allowance",
  "transport_allowance",
  "department",
  "position",
  "insurance_premium",
];

const ALLOW_LIST = new Set<string>([
  // The architecture-guard test itself naturally mentions the names.
  "src/test/architecture/employees-no-legacy-comp-cols.test.ts",
  "src/test/architecture/employees-lifecycle-writes.test.ts",
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

describe("employees: dropped legacy compensation columns are not re-introduced", () => {
  it("no `.from(\"employees\").select(...)` chain references the dropped columns", () => {
    const files = walk("src").filter(
      (f) => !f.endsWith(".d.ts") && !f.includes("integrations/supabase/types.ts"),
    );

    const violations: string[] = [];
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOW_LIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      if (!/\.from\(["']employees["']\)/.test(src)) continue;

      // Match the .from("employees")…select(string) chain (string literal only).
      const selectRegex = /\.from\(["']employees["']\)[\s\S]{0,400}?\.select\(\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = selectRegex.exec(src))) {
        const sel = m[1];
        for (const col of DROPPED_COLS) {
          const tokenRegex = new RegExp(`(^|[\\s,(])${col}(\\s*[,)]|\\s|$)`);
          if (tokenRegex.test(sel)) {
            violations.push(`${rel}: \`.from("employees").select(\"… ${col} …\")\` — column was dropped in Wave 1.1; read v_employees_safe or employee_contracts instead.`);
          }
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});
