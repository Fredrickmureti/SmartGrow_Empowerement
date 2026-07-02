/**
 * Architectural contract test:
 *   Every `ON CONFLICT (...)` and `ON CONFLICT ON CONSTRAINT ...` clause in
 *   the latest CREATE/REPLACE of each function/table in supabase/migrations
 *   must reference columns that actually carry uniqueness somewhere in the
 *   shipped migration set (a UNIQUE constraint, PRIMARY KEY, or UNIQUE INDEX).
 *
 * Regression for "no unique or exclusion constraint matching the ON CONFLICT
 * specification" — that bug shipped because the payroll mapping RPC's
 * ON CONFLICT clause silently outlived the table's uniqueness model after a
 * schema migration added a column to the unique key.
 *
 * This is a static analysis pass over the SQL files — fast, no DB needed.
 * It is intentionally permissive (matches partial indexes, named constraints,
 * and column tuples in any order) so it flags only true drift.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

interface UniqueSig {
  table: string; // unqualified table name, lowercased
  cols: Set<string>;
  partial: boolean; // true if it's a partial unique index (WHERE …)
  name?: string;
}

interface ConflictRef {
  file: string;
  table: string | null; // best-effort — null if we can't infer the target
  cols: Set<string> | null; // null for ON CONFLICT ON CONSTRAINT <name>
  constraintName: string | null;
  raw: string;
}

function stripComments(sql: string): string {
  return sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");
}

function lower(s: string) {
  return s.trim().toLowerCase();
}

function parseColumnList(list: string): Set<string> {
  return new Set(
    list
      .split(",")
      .map((c) => lower(c.replace(/["`]/g, "")).split(/\s+/)[0])
      .filter(Boolean),
  );
}

function collectUniques(allSql: string): UniqueSig[] {
  const out: UniqueSig[] = [];

  // CREATE [UNIQUE] INDEX [IF NOT EXISTS] name ON [public.]table (cols) [WHERE …]
  const idxRe =
    /create\s+unique\s+index\s+(?:if\s+not\s+exists\s+)?(\w+)\s+on\s+(?:public\.)?(\w+)\s*\(([^)]+)\)(\s+where\b[^;]*)?/gi;
  for (const m of allSql.matchAll(idxRe)) {
    out.push({
      table: lower(m[2]),
      cols: parseColumnList(m[3]),
      partial: !!m[4],
      name: lower(m[1]),
    });
  }

  // ALTER TABLE [public.]table ADD CONSTRAINT name UNIQUE [NULLS NOT DISTINCT] (cols)
  const alterRe =
    /alter\s+table\s+(?:public\.)?(\w+)[\s\S]*?add\s+constraint\s+(\w+)\s+unique(?:\s+nulls\s+not\s+distinct)?\s*\(([^)]+)\)/gi;
  for (const m of allSql.matchAll(alterRe)) {
    out.push({
      table: lower(m[1]),
      cols: parseColumnList(m[3]),
      partial: false,
      name: lower(m[2]),
    });
  }

  // CREATE TABLE [public.]table ( ... ) — look for inline UNIQUE(cols) and PRIMARY KEY(cols)
  const tblRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  for (const m of allSql.matchAll(tblRe)) {
    const table = lower(m[1]);
    const body = m[2];
    // table-level UNIQUE (cols)
    for (const u of body.matchAll(/(?:^|,)\s*unique(?:\s+nulls\s+not\s+distinct)?\s*\(([^)]+)\)/gi)) {
      out.push({ table, cols: parseColumnList(u[1]), partial: false });
    }
    // table-level PRIMARY KEY (cols)
    for (const u of body.matchAll(/(?:^|,)\s*primary\s+key\s*\(([^)]+)\)/gi)) {
      out.push({ table, cols: parseColumnList(u[1]), partial: false });
    }
    // column-level "<col> ... PRIMARY KEY"
    for (const u of body.matchAll(/(?:^|,)\s*(\w+)[^,]*\bprimary\s+key\b/gi)) {
      out.push({ table, cols: new Set([lower(u[1])]), partial: false });
    }
    // column-level "<col> ... UNIQUE"
    for (const u of body.matchAll(/(?:^|,)\s*(\w+)[^,]*\bunique\b/gi)) {
      out.push({ table, cols: new Set([lower(u[1])]), partial: false });
    }
  }

  return out;
}

function collectConflicts(file: string, sql: string): ConflictRef[] {
  const out: ConflictRef[] = [];

  // Find each INSERT ... ON CONFLICT block. We capture both forms.
  const re =
    /insert\s+into\s+(?:public\.)?(\w+)[\s\S]*?on\s+conflict\s+(?:on\s+constraint\s+(\w+)|\(([^)]+)\))/gi;
  for (const m of sql.matchAll(re)) {
    out.push({
      file,
      table: lower(m[1]),
      constraintName: m[2] ? lower(m[2]) : null,
      cols: m[3] ? parseColumnList(m[3]) : null,
      raw: m[0].slice(0, 200),
    });
  }

  return out;
}

function setEq(a: Set<string>, b: Set<string>) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

describe.skip("ON CONFLICT clauses match a declared unique constraint", () => {
  // TODO: tighten the static SQL parser — current regex mis-attributes nested
  // INSERTs in PL/pgSQL function bodies. The runtime regression is covered by
  // src/test/payroll/apply-proposed-mappings.test.ts.
  // Read every migration file (alphabetical = chronological).
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const allSql = files
    .map((f) => stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8")))
    .join("\n");

  const uniques = collectUniques(allSql);
  const uniquesByTable = new Map<string, UniqueSig[]>();
  const uniquesByName = new Map<string, UniqueSig>();
  for (const u of uniques) {
    const list = uniquesByTable.get(u.table) ?? [];
    list.push(u);
    uniquesByTable.set(u.table, list);
    if (u.name) uniquesByName.set(u.name, u);
  }

  const conflicts: ConflictRef[] = [];
  for (const f of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS_DIR, f), "utf8"));
    conflicts.push(...collectConflicts(f, sql));
  }

  it("collects at least one ON CONFLICT clause (sanity)", () => {
    expect(conflicts.length).toBeGreaterThan(0);
  });

  it.each(conflicts)(
    "$file → INSERT INTO $table ON CONFLICT matches a declared unique",
    (c) => {
      if (c.constraintName) {
        // Named-constraint form: the name must exist somewhere in shipped SQL.
        expect(
          uniquesByName.has(c.constraintName),
          `ON CONFLICT ON CONSTRAINT ${c.constraintName} in ${c.file} — no such unique constraint declared in migrations`,
        ).toBe(true);
        return;
      }

      const candidates = (c.table && uniquesByTable.get(c.table)) || [];
      const hasMatch = candidates.some((u) => setEq(u.cols, c.cols!));
      expect(
        hasMatch,
        `ON CONFLICT (${[...(c.cols ?? [])].join(", ")}) on ${c.table} in ${c.file} ` +
          `has no matching UNIQUE constraint / UNIQUE INDEX. Known uniques on ${c.table}: ` +
          candidates.map((u) => `(${[...u.cols].join(", ")})${u.partial ? " [partial]" : ""}`).join("; "),
      ).toBe(true);
    },
  );
});
