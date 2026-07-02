/**
 * Architecture guard: every operational SELECT against the employees
 * relation must go through `v_employees_canonical` (list/aggregate) or
 * `v_employees_safe` (single-row PII-masked). Direct `.from("employees")
 * .select(...)` reads are forbidden outside a small write-back allowlist
 * — those files only need the base table for UPDATE/DELETE/INSERT.
 *
 * The reported symptom — "Statistics says 1, Directory shows none" — was
 * caused by different consumers re-implementing their own definition of
 * "active". This test makes the architecture self-enforcing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ALLOW_LIST = new Set<string>([
  // Hooks/components that only WRITE to employees (update/delete/insert) and
  // do not perform operational SELECTs. The scanner below ignores
  // .from("employees").update/.delete/.insert chains automatically; this
  // allowlist covers files where a small post-write SELECT snapshot is
  // intentionally taken against the base table (e.g. for automation old_data).
  "src/hooks/useEmployees.ts",
  // PII-authoritative reader.
  "src/hooks/useEmployeePii.ts",
  // Server-side admin path (uses supabaseAdmin, not the user client).
  "src/routes/api/public/attendance.ingest.ts",
  // Natural-key resolver runs `.or(email.eq, work_email.eq)` which the
  // canonical view doesn't expose with the same predicate cost. Keep on
  // base table; PII is not selected.
  "src/lib/hr/resolveEmployeeNaturalKeys.ts",
  // Architecture tests themselves reference the literal string.
  "src/test/architecture/employees-reads-via-canonical.test.ts",
  "src/test/architecture/no-raw-employees-pii-select.test.ts",
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

describe("employees read lockdown", () => {
  it("no operational .from('employees').select(...) outside the write-back allowlist", () => {
    const files = walk("src").filter(
      (f) => !f.endsWith(".d.ts") && !f.includes("integrations/supabase/types.ts"),
    );

    const violations: string[] = [];
    const re = /\.from\(\s*["']employees["']\s*\)([\s\S]{0,300}?)(?=\.(?:select|update|delete|insert|upsert))\.(select|update|delete|insert|upsert)/g;
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOW_LIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (m[2] === "select") {
          const linesBefore = src.slice(0, m.index).split("\n").length;
          violations.push(
            `${rel}:${linesBefore}: SELECT against base 'employees' — read v_employees_canonical (list) or v_employees_safe (single row).`,
          );
        }
      }
    }

    expect(violations, "\n" + violations.join("\n")).toEqual([]);
  });
});
