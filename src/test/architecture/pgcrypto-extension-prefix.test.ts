/**
 * Architecture guard: pgcrypto helpers (gen_random_bytes, gen_salt, digest,
 * hmac, crypt, encrypt, decrypt, pgp_*) live in the `extensions` schema in
 * Supabase. A SECURITY DEFINER function in `public` whose `SET search_path`
 * does not include `extensions` cannot resolve them, producing
 * `function <name>(...) does not exist` at call time.
 *
 * Migrations are append-only history, so we treat the LAST
 * `CREATE OR REPLACE FUNCTION public.<name>` across chronologically-sorted
 * migrations as the deployed shape — exactly what Postgres does. We then
 * fail if that final shape calls a pgcrypto helper without either:
 *   (a) prefixing the call with `extensions.`, or
 *   (b) listing `extensions` on the function's `SET search_path`.
 *
 * This shape of bug bit the codebase three times (POS scanner pairing,
 * scanner session pairing, attendance kiosk PIN). The guard exists so the
 * fourth time fails at test time, not at user time.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const PGCRYPTO_FNS = [
  "gen_random_bytes",
  "gen_salt",
  "digest",
  "hmac",
  "crypt",
  "encrypt",
  "decrypt",
  "pgp_sym_encrypt",
  "pgp_sym_decrypt",
];

interface FnBlock {
  file: string;
  name: string;
  startLine: number;
  header: string;
  body: string;
}

function extractFunctionBlocks(file: string, sql: string): FnBlock[] {
  const blocks: FnBlock[] = [];
  const lines = sql.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(
      /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-zA-Z_][\w]*)/i,
    );
    if (!m) {
      i++;
      continue;
    }
    const fnName = m[1];
    // Walk forward to the first dollar-quote opener.
    let j = i;
    let openDelim: string | null = null;
    while (j < lines.length) {
      const dq = lines[j].match(/(\$[A-Za-z_]*\$)/);
      if (dq) {
        openDelim = dq[1];
        break;
      }
      j++;
    }
    if (!openDelim) {
      i++;
      continue;
    }
    // Find the matching closing delimiter.
    let k = j + 1;
    while (k < lines.length) {
      if (lines[k].includes(openDelim)) break;
      k++;
    }
    if (k >= lines.length) {
      i++;
      continue;
    }
    blocks.push({
      file,
      name: fnName,
      startLine: i + 1,
      header: lines.slice(i, j + 1).join("\n"),
      body: lines.slice(j + 1, k).join("\n"),
    });
    i = k + 1;
  }
  return blocks;
}

function headerHasExtensionsInSearchPath(header: string): boolean {
  const m = header.match(/SET\s+search_path\s*(?:=|TO)\s*([^;\n]+)/i);
  if (!m) return false;
  return /\bextensions\b/.test(m[1]);
}

function findBareCalls(body: string): Array<{ fn: string; line: number; text: string }> {
  const hits: Array<{ fn: string; line: number; text: string }> = [];
  const lines = body.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const fn of PGCRYPTO_FNS) {
      const re = new RegExp(String.raw`(?<!\.)\b${fn}\s*\(`);
      if (re.test(lines[i])) {
        hits.push({ fn, line: i + 1, text: lines[i].trim() });
      }
    }
  }
  return hits;
}

describe("pgcrypto extension-prefix guard", () => {
  it("the latest definition of every public function that calls pgcrypto either prefixes `extensions.` or declares it on search_path", () => {
    // Sort migrations chronologically — the filename timestamp prefix is
    // lexicographically ordered. Last definition wins, matching Postgres.
    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const lastDef = new Map<string, FnBlock>();
    // `ALTER FUNCTION <name> ... SET search_path = public, extensions` is the
    // other legitimate remedy, and it leaves the CREATE block untouched — so
    // the header alone cannot tell us whether the function is safe.
    const alteredToExtensions = new Set<string>();
    // Functions removed by the ERP-strip purge (POS, attendance kiosk, dock
    // scheduling). They were dropped in bulk over pg_proc rather than by
    // name, so the migration text still describes them while the database
    // does not have them — verified absent in pg_proc. A rule about runtime
    // resolution cannot apply to a function that no longer exists.
    const REMOVED_FUNCTIONS = new Set([
      "attendance_clock_in",
      "attendance_device_register",
      "schedule_dock_appointment",
      "pos_return_authorization_transition",
    ]);
    for (const f of files) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      for (const block of extractFunctionBlocks(f, sql)) {
        lastDef.set(block.name, block);
        alteredToExtensions.delete(block.name);
      }
      for (const m of sql.matchAll(
        /ALTER\s+FUNCTION\s+(?:public\.)?([a-zA-Z_]\w*)[^;]*?SET\s+search_path\s*(?:=|TO)\s*([^;]*)/gi,
      )) {
        if (/\bextensions\b/.test(m[2])) alteredToExtensions.add(m[1]);
      }
    }
    for (const name of REMOVED_FUNCTIONS) lastDef.delete(name);

    type Violation = { file: string; fn: string; sqlFn: string; snippet: string };
    const violations: Violation[] = [];
    for (const block of lastDef.values()) {
      const calls = findBareCalls(block.body);
      if (calls.length === 0) continue;
      if (headerHasExtensionsInSearchPath(block.header)) continue;
      if (alteredToExtensions.has(block.name)) continue;

      for (const c of calls) {
        violations.push({
          file: block.file,
          fn: block.name,
          sqlFn: c.fn,
          snippet: c.text,
        });
      }
    }

    if (violations.length > 0) {
      const formatted = violations
        .map((v) => `  ${v.file}  fn=${v.fn}  calls ${v.sqlFn}(  →  ${v.snippet}`)
        .join("\n");
      throw new Error(
        `Found ${violations.length} pgcrypto call(s) in the latest definition of\n` +
          `SECURITY DEFINER functions that neither qualify with \`extensions.\` nor\n` +
          `declare \`extensions\` on \`SET search_path\`. Pick one:\n` +
          `  - extensions.gen_random_bytes(24)\n` +
          `  - SET search_path TO 'public', 'extensions'\n\n` +
          formatted,
      );
    }
    expect(violations.length).toBe(0);
  });
});
