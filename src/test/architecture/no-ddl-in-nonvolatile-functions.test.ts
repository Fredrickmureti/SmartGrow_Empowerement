/**
 * Postgres refuses DDL inside a STABLE/IMMUTABLE function: any `CREATE TABLE`
 * (including `CREATE TEMP TABLE`) raises
 *   "CREATE TABLE is not allowed in a non-volatile function"
 * the first time the statement is planned, which surfaced as a whole-page
 * "Error loading report" on Sales Reports.
 *
 * A read-only reporting engine must stay STABLE (it is SECURITY DEFINER and
 * must not be able to write), so the correct fix is to express the working set
 * as CTEs — never to relax the volatility. This ratchet enforces that.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

type FnBlock = { file: string; header: string; body: string };

function functionBlocks(): FnBlock[] {
  const blocks: FnBlock[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION[\s\S]*?(\$[A-Za-z_]*\$)([\s\S]*?)\1/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const header = sql.slice(m.index, m.index + (m[0].length - m[2].length));
      blocks.push({ file, header, body: m[2] });
    }
  }
  return blocks;
}

describe("non-volatile SQL functions contain no DDL", () => {
  it("no STABLE/IMMUTABLE function creates a table", () => {
    const offenders = functionBlocks()
      .filter((b) => /\b(STABLE|IMMUTABLE)\b/i.test(b.header))
      .filter((b) => /\bCREATE\s+(?:TEMP(?:ORARY)?\s+|UNLOGGED\s+)*TABLE\b/i.test(b.body))
      .map((b) => `${b.file}: ${/FUNCTION\s+([\w.]+)/i.exec(b.header)?.[1] ?? "?"}`);

    expect(offenders, "DDL inside a non-volatile function fails at plan time").toEqual([]);
  });
});
