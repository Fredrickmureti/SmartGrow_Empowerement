/**
 * Wave F5 — Lifecycle write lockdown via RPCs.
 *
 * `employments` and `employee_position_history` are lifecycle-critical tables.
 * All writes MUST go through the SECURITY DEFINER RPCs that maintain
 * spell integrity + audit trail:
 *   - terminate_employee, rehire_employee
 *   - transfer_employee
 *   - change_compensation
 *
 * This test fails CI if any non-allowlisted file calls
 * `.from("employments").insert|update|delete(...)` or
 * `.from("employee_position_history").insert|update|delete(...)` directly
 * from app code — bypassing the RPC also bypasses the audit row, position
 * history sync, and the spell-overlap check.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const LIFECYCLE_TABLES = ["employments", "employee_position_history"];

// The canonical lifecycle hook is allowed to write `employments` directly
// for the bootstrap path; rehire/terminate/transfer go through RPCs.
const ALLOW_LIST = new Set<string>([
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

describe("employee lifecycle: writes go through RPCs, not direct table calls", () => {
  it("no app code writes employments/employee_position_history directly", () => {
    const files = walk("src").filter(
      (f) => !f.includes("/test/") && !f.endsWith(".d.ts") && !f.includes("integrations/supabase/types.ts"),
    );

    const violations: string[] = [];
    for (const file of files) {
      const rel = file.replace(/\\/g, "/");
      if (ALLOW_LIST.has(rel)) continue;
      const src = readFileSync(file, "utf8");

      for (const table of LIFECYCLE_TABLES) {
        const re = new RegExp(
          `\\.from\\(["']${table}["']\\)[\\s\\S]{0,400}?\\.(insert|update|delete|upsert)\\b`,
          "g",
        );
        if (re.test(src)) {
          violations.push(`${rel} writes ${table} directly — use the lifecycle RPC instead.`);
        }
      }
    }

    expect(violations, violations.join("\n")).toEqual([]);
  });
});