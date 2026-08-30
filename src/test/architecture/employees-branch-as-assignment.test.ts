/**
 * Architecture guard: branch as 0..N assignment (ADR 0039).
 *
 * 1. No production code under `src/` may write `branch_id` on the employees
 *    table — all branch movement must go through the
 *    `assign_employee_to_branch` / `transfer_employee_primary_branch` RPCs.
 *    The DB enforces this with a trigger; this test is the compile-time
 *    safety net.
 *
 * 2. Operational reads must not pull `branch_id` from the employees table
 *    in nested selects. They should use `v_employees_canonical` and the
 *    `primary_branch_id` / `branch_ids` columns instead.
 *
 * A narrow file allowlist exists for transitional / lifecycle code that
 * legitimately reads or sets the mirror column until Phase E drops it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

const WRITE_ALLOWLIST = new Set<string>([
  // Lifecycle / draft promotion helpers may set branch_id at create time
  // through the SECURITY DEFINER RPC, not via direct PostgREST writes.
  // Add narrowly-scoped paths here only with a written justification.
]);

const READ_ALLOWLIST = new Set<string>([
  // Tests, the canonical-view hook, and PII hooks may still reference the
  // legacy column for back-compat shape during Phase B → E transition.
  "src/hooks/useEmployees.ts",
  "src/hooks/useEmployeePii.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "test") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const FILES = walk(SRC);

describe("employees.branch_id is an assignment, not an ownership column", () => {
  it("no .from('employees').update/insert/upsert writes branch_id", () => {
    const violations: { file: string; snippet: string }[] = [];
    const re =
      /\.from\(\s*["']employees["']\s*\)[\s\S]{0,400}?\.(?:update|insert|upsert)\(\s*\{[\s\S]{0,800}?\}/g;
    for (const file of FILES) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (WRITE_ALLOWLIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        if (/\bbranch_id\s*:/.test(m[0])) {
          violations.push({ file: rel, snippet: m[0].slice(0, 200) });
        }
      }
    }
    expect(
      violations,
      `Direct writes of employees.branch_id are forbidden — use ` +
        `assign_employee_to_branch / transfer_employee_primary_branch.\n` +
        violations.map((v) => `- ${v.file}: ${v.snippet}`).join("\n"),
    ).toEqual([]);
  });

  it("nested employees(...) selects do not pull branch_id (use v_employees_canonical.primary_branch_id)", () => {
    const violations: { file: string; snippet: string }[] = [];
    // Match `employees(...col list...)` or `employee:employees(...col list...)`.
    const re = /\bemployees\s*\(([^()]{0,400})\)/g;
    for (const file of FILES) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (READ_ALLOWLIST.has(rel)) continue;
      if (rel.includes("/test/") || rel.endsWith(".test.ts")) continue;
      const src = readFileSync(file, "utf8");
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const inside = m[1];
        if (/\bbranch_id\b/.test(inside)) {
          violations.push({ file: rel, snippet: m[0].slice(0, 160) });
        }
      }
    }
    expect(
      violations,
      `Nested employees(...) selects must not pull branch_id. ` +
        `Use v_employees_canonical(..., primary_branch_id, branch_ids) instead.\n` +
        violations.map((v) => `- ${v.file}: ${v.snippet}`).join("\n"),
    ).toEqual([]);
  });
});
