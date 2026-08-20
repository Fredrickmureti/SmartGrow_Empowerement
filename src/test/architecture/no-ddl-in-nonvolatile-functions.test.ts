/**
 * Postgres refuses DDL inside a STABLE/IMMUTABLE function: any `CREATE TABLE`
 * (including `CREATE TEMP TABLE`) raises
 *   "CREATE TABLE is not allowed in a non-volatile function"
 * the first time the statement is planned, which surfaced as a whole-page
 * "Error loading report" on Sales Reports.
 *
 * A read-only reporting engine must stay STABLE (it is SECURITY DEFINER and
 * must not be able to write), so the correct fix is to express the working set
 * as CTEs — never to relax the volatility. This ratchet asserts the *current*
 * definition (newest migration defining each function), so replacing a broken
 * body is enough; historical migrations are not rewritten.
 */
import { describe, it, expect } from "vitest";
import { latestMigrationDefining } from "./support/enumStatusLiterals";

/** Read-only report engines whose bodies must contain no DDL. */
const REPORT_ENGINES = [
  "finance_sales_analysis",
  "finance_sales_revenue_reconciliation",
  "get_sales_dashboard_kpis",
];

function bodyOf(sql: string, fn: string): string {
  const re = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${fn}\\b[\\s\\S]*?(\\$[A-Za-z_]*\\$)([\\s\\S]*?)\\1`,
    "i",
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`could not extract body of ${fn}`);
  return m[2];
}

describe.each(REPORT_ENGINES)("%s contains no DDL", (fn) => {
  it("creates no table (fails at plan time in a non-volatile function)", () => {
    const body = bodyOf(latestMigrationDefining(fn), fn);
    expect(/\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)*TABLE\b/i.test(body)).toBe(false);
  });
});
