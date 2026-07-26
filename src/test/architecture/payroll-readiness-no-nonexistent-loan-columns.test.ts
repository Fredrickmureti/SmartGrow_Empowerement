/**
 * Architecture guard — payroll_required_gl_mappings_for_run must not reference
 * columns that don't exist on `public.loan_types`.
 *
 * Regression fixed:
 *   ERROR 42703: column lt.interest_rate does not exist
 *   HINT: Perhaps you meant to reference the column "l.interest_rate".
 *
 * Interest lives in two distinct places by design:
 *   - `loan_types.requires_interest` (bool)  — policy flag
 *   - `employee_loans.interest_rate` (num)   — contract on an issued loan
 *
 * `loan_types` has NO `interest_rate` column, and never should — a rate on the
 * type would collapse two orthogonal concepts. The readiness function must
 * derive "does this run's usage of the type require an interest_income
 * account?" from BOTH signals, aggregated per type. This guard fails if the
 * function reintroduces a reference to a fabricated `loan_types.interest_rate`
 * (via any alias of that table).
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MIG_DIR = join(process.cwd(), "supabase", "migrations");

function latestMigrationBodyDefining(fnName: string): string {
  const files = readdirSync(MIG_DIR).filter((f) => f.endsWith(".sql")).sort();
  const marker = new RegExp(`FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i");
  for (let i = files.length - 1; i >= 0; i--) {
    const p = join(MIG_DIR, files[i]);
    if (!statSync(p).isFile()) continue;
    const body = readFileSync(p, "utf8");
    if (marker.test(body)) return body;
  }
  throw new Error(`no migration defines ${fnName}`);
}

describe("payroll_required_gl_mappings_for_run — loan_types column contract", () => {
  const sql = latestMigrationBodyDefining("payroll_required_gl_mappings_for_run");

  it("never references a fabricated loan_types.interest_rate column", () => {
    // Fully-qualified form.
    expect(sql).not.toMatch(/loan_types\.interest_rate\b/i);
    // Any alias of loan_types (typically `lt`) with .interest_rate. We isolate
    // the loan_types_used CTE and assert no `.interest_rate` reference exists
    // there — that CTE is the only place loan_types is aliased.
    const cteMatch = sql.match(/loan_types_used\s+AS\s*\(([\s\S]*?)\)\s*,/i);
    expect(cteMatch, "loan_types_used CTE not found").toBeTruthy();
    const cte = cteMatch![1];
    // Only l.interest_rate (employee_loans) is legitimate; lt.interest_rate is not.
    expect(cte).not.toMatch(/\blt\.interest_rate\b/i);
  });

  it("derives interest requirement from requires_interest OR l.interest_rate", () => {
    // The corrected aggregation must consult BOTH the policy flag and the
    // contract rate — using either alone is a known-wrong signal.
    expect(sql).toMatch(/requires_interest/);
    expect(sql).toMatch(/l\.interest_rate/);
    expect(sql).toMatch(/bool_or\s*\(/i);
  });
});
